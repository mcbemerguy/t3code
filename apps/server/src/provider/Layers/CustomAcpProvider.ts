// @effect-diagnostics nodeBuiltinImport:off
import { setTimeout as sleep } from "node:timers/promises";

import type {
  CustomAcpSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
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
const CUSTOM_ACP_COMMAND_DISCOVERY_TIMEOUT_MS = 200;

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

type CustomAcpDiscoveryResult =
  | {
      readonly timedOut: false;
      readonly version: string | null;
      readonly models: ServerProvider["models"];
      readonly slashCommands: Option.Option<ReadonlyArray<ServerProviderSlashCommand>>;
    }
  | {
      readonly timedOut: true;
    };

export const discoverCustomAcpModelsViaAcp = (
  settings: CustomAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  CustomAcpDiscoveryResult,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const discover = Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeCustomAcpRuntime({
      settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-custom-acp-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();

    let commandState = yield* runtime.getAvailableCommandsState;
    if (commandState.updateCount === 0) {
      yield* Effect.promise(() => sleep(CUSTOM_ACP_COMMAND_DISCOVERY_TIMEOUT_MS));
      commandState = yield* runtime.getAvailableCommandsState;
    }
    return {
      timedOut: false,
      version: started.initializeResult.agentInfo?.version?.trim() || null,
      models: buildCustomAcpProviderModels({
        configOptions: started.sessionSetupResult.configOptions ?? [],
        manualModels: settings.manualModels,
      }),
      slashCommands:
        commandState.updateCount > 0 ? Option.some(commandState.commands) : Option.none(),
    } satisfies CustomAcpDiscoveryResult;
  }).pipe(Effect.scoped);

  return discover.pipe(
    Effect.timeoutOption(CUSTOM_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.map((result) =>
      Option.match(result, {
        onNone: () => ({ timedOut: true }) as const,
        onSome: (value) => value,
      }),
    ),
  );
};

export const checkCustomAcpProviderStatus = Effect.fn("checkCustomAcpProviderStatus")(function* (
  settings: CustomAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = customAcpFallbackModels(settings);

  if (!settings.enabled || !settings.command.trim()) {
    return yield* buildInitialCustomAcpProviderSnapshot(settings);
  }

  const discoveryExit = yield* Effect.exit(discoverCustomAcpModelsViaAcp(settings, environment));

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

  const discovered = discoveryExit.value;
  if (discovered.timedOut) {
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

  return buildServerProvider({
    presentation: CUSTOM_ACP_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discovered.models,
    ...(Option.isSome(discovered.slashCommands)
      ? { slashCommands: discovered.slashCommands.value }
      : {}),
    probe: {
      installed: true,
      version: discovered.version,
      status: "ready",
      auth: authSnapshot(settings),
    },
  });
});
