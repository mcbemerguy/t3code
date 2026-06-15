import { ProviderDriverKind, type PiSettings, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export const DEFAULT_PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Pi default",
    isCustom: false,
    capabilities: DEFAULT_PI_MODEL_CAPABILITIES,
  },
];

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runPiCommand = Effect.fn("runPiCommand")(function* (
  piSettings: PiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const command = ChildProcess.make(piSettings.binaryPath, [...args], {
    env: environment,
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(piSettings.binaryPath, command);
});

export const makePendingPiProvider = (piSettings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models: DEFAULT_PI_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: DEFAULT_PI_MODELS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi provider status has not been checked in this session yet.",
      },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!piSettings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: DEFAULT_PI_MODELS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runPiCommand(piSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    const message = error instanceof Error ? error.message : String(error);
    const missing = isCommandMissingCause({ message });
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: DEFAULT_PI_MODELS,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : `Failed to execute Pi CLI health check: ${message}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: DEFAULT_PI_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const result = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    const detail = detailFromResult(result);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: DEFAULT_PI_MODELS,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Pi CLI is installed but failed to run. ${detail}`
          : "Pi CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    driver: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: DEFAULT_PI_MODELS,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "warning",
      auth: { status: "unknown", label: "Managed by Pi" },
      message: "Pi CLI is installed. Native Pi chat sessions are available through Pi RPC.",
    },
  });
});
