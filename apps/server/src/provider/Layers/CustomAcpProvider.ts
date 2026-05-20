import type { CustomAcpSettings, ServerProvider, ServerProviderAuth } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  buildCustomAcpProviderModels,
  makeCustomAcpRuntime,
  normalizeCustomAcpAuthMethodId,
} from "../acp/CustomAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const CUSTOM_ACP_PRESENTATION = {
  displayName: "Custom ACP",
  badgeLabel: "Custom",
  showInteractionModeToggle: true,
} as const;
const CUSTOM_ACP_DISCOVERY_TIMEOUT_MS = 15_000;

function customAcpFallbackModels(settings: CustomAcpSettings) {
  return buildCustomAcpProviderModels({ manualModels: settings.manualModels });
}

function authSnapshot(settings: CustomAcpSettings): ServerProviderAuth {
  const method = normalizeCustomAcpAuthMethodId(settings.authMethodId);
  return {
    status: "unknown",
    ...(method ? { type: method, label: method } : {}),
  };
}

export function buildInitialCustomAcpProviderSnapshot(
  settings: CustomAcpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = customAcpFallbackModels(settings);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: CUSTOM_ACP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: authSnapshot(settings),
          message: "Custom ACP is disabled in this provider instance.",
        },
      });
    }

    if (!settings.command.trim()) {
      return buildServerProvider({
        presentation: CUSTOM_ACP_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: authSnapshot(settings),
          message: "Custom ACP command is required.",
        },
      });
    }

    return buildServerProvider({
      presentation: CUSTOM_ACP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: authSnapshot(settings),
        message: "Checking Custom ACP availability...",
      },
    });
  });
}

export const discoverCustomAcpModelsViaAcp = (
  settings: CustomAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  {
    readonly version: string | null;
    readonly models: ServerProvider["models"];
  },
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeCustomAcpRuntime({
      settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-custom-acp-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return {
      version: started.initializeResult.agentInfo?.version?.trim() || null,
      models: buildCustomAcpProviderModels({
        configOptions: started.sessionSetupResult.configOptions ?? [],
        manualModels: settings.manualModels,
      }),
    };
  }).pipe(Effect.scoped);

export const checkCustomAcpProviderStatus = Effect.fn("checkCustomAcpProviderStatus")(function* (
  settings: CustomAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = customAcpFallbackModels(settings);

  if (!settings.enabled || !settings.command.trim()) {
    return yield* buildInitialCustomAcpProviderSnapshot(settings);
  }

  const discoveryExit = yield* Effect.exit(
    discoverCustomAcpModelsViaAcp(settings, environment).pipe(
      Effect.timeoutOption(CUSTOM_ACP_DISCOVERY_TIMEOUT_MS),
    ),
  );

  if (Exit.isFailure(discoveryExit)) {
    const message = Cause.pretty(discoveryExit.cause);
    yield* Effect.logWarning("Custom ACP discovery failed", { cause: message });
    return buildServerProvider({
      presentation: CUSTOM_ACP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause({ message }),
        version: null,
        status: "error",
        auth: authSnapshot(settings),
        message: isCommandMissingCause({ message })
          ? "Custom ACP command is not installed or not on PATH."
          : `Custom ACP probe failed: ${message}`,
      },
    });
  }

  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: CUSTOM_ACP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: authSnapshot(settings),
        message: `Custom ACP probe timed out after ${CUSTOM_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovered = discoveryExit.value.value;
  return buildServerProvider({
    presentation: CUSTOM_ACP_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discovered.models,
    probe: {
      installed: true,
      version: discovered.version,
      status: "ready",
      auth: authSnapshot(settings),
    },
  });
});
