import {
  ProviderDriverKind,
  type PiSettings,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { normalizePiCommands, withPiNativeSlashCommands } from "./PiCommands.ts";
import { FALLBACK_PI_MODELS, normalizePiAvailableModels } from "./PiModels.ts";
import { PiRpcProcessHandle } from "./PiRpcProcess.ts";
import { PiRpcLifecycleError, type PiRpcRuntimeMessage } from "./PiSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_VERSION_PROBE_TIMEOUT_MS = 10_000;
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

export const DEFAULT_PI_MODELS: ReadonlyArray<ServerProviderModel> = FALLBACK_PI_MODELS;

interface PiModelDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usedFallback: boolean;
  readonly rpcHealthy: boolean;
  readonly detail?: string;
}

interface PiCommandDiscoveryResult {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly detail?: string;
}

interface PiCapabilitiesDiscoveryResult extends PiModelDiscoveryResult {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly commandDetail?: string;
}

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

function piDiscoveryError(error: unknown): PiRpcLifecycleError {
  return error instanceof PiRpcLifecycleError
    ? error
    : new PiRpcLifecycleError(error instanceof Error ? error.message : String(error), error);
}

function modelResultFromResponse(response: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}): PiModelDiscoveryResult {
  if (!response.success) {
    return {
      models: FALLBACK_PI_MODELS,
      usedFallback: true,
      rpcHealthy: false,
      detail: response.error ?? "Pi RPC get_available_models returned an unsuccessful response.",
    };
  }
  const models = normalizePiAvailableModels(response.data);
  return {
    models,
    usedFallback: models === FALLBACK_PI_MODELS,
    rpcHealthy: true,
  };
}

function commandResultFromResponse(response: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}): PiCommandDiscoveryResult {
  if (!response.success) {
    return {
      slashCommands: withPiNativeSlashCommands([]),
      skills: [],
      detail: response.error ?? "Pi RPC get_commands returned an unsuccessful response.",
    };
  }
  const commands = normalizePiCommands(response.data);
  return {
    ...commands,
    slashCommands: withPiNativeSlashCommands(commands.slashCommands),
  };
}

export const discoverPiCapabilitiesViaRpc = Effect.fn("discoverPiCapabilitiesViaRpc")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<PiCapabilitiesDiscoveryResult, PiRpcLifecycleError> {
  const messages = yield* Queue.unbounded<PiRpcRuntimeMessage>();
  const handle = yield* Effect.tryPromise({
    try: () =>
      PiRpcProcessHandle.spawn({
        command: piSettings.binaryPath,
        cwd: process.cwd(),
        environment,
        messages,
      }),
    catch: piDiscoveryError,
  });

  return yield* Effect.gen(function* () {
    const modelResponse = yield* Effect.tryPromise({
      try: () => handle.request({ type: "get_available_models" }, 3_000),
      catch: piDiscoveryError,
    }).pipe(Effect.result);
    const commandResponse = yield* Effect.tryPromise({
      try: () => handle.request({ type: "get_commands" }, 3_000),
      catch: piDiscoveryError,
    }).pipe(Effect.result);

    const models = Result.isSuccess(modelResponse)
      ? modelResultFromResponse(modelResponse.success)
      : ({
          models: FALLBACK_PI_MODELS,
          usedFallback: true,
          detail: modelResponse.failure.message,
          rpcHealthy: false,
        } satisfies PiModelDiscoveryResult);
    const commands = Result.isSuccess(commandResponse)
      ? commandResultFromResponse(commandResponse.success)
      : ({
          slashCommands: withPiNativeSlashCommands([]),
          skills: [],
          detail: commandResponse.failure.message,
        } satisfies PiCommandDiscoveryResult);

    return {
      ...models,
      slashCommands: commands.slashCommands,
      skills: commands.skills,
      ...(commands.detail ? { commandDetail: commands.detail } : {}),
    } satisfies PiCapabilitiesDiscoveryResult;
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => handle.terminate({ attemptAbort: false })).pipe(Effect.ignore),
    ),
  );
});

export const discoverPiModelsViaRpc = Effect.fn("discoverPiModelsViaRpc")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<PiModelDiscoveryResult, PiRpcLifecycleError> {
  const discovery = yield* discoverPiCapabilitiesViaRpc(piSettings, environment);
  return {
    models: discovery.models,
    usedFallback: discovery.usedFallback,
    rpcHealthy: discovery.rpcHealthy,
    ...(discovery.detail ? { detail: discovery.detail } : {}),
  } satisfies PiModelDiscoveryResult;
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
    Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
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

  const capabilitiesDiscovery = yield* discoverPiCapabilitiesViaRpc(piSettings, environment).pipe(
    Effect.timeoutOption(8_000),
    Effect.result,
  );
  const discoveredCapabilities =
    Result.isSuccess(capabilitiesDiscovery) && Option.isSome(capabilitiesDiscovery.success)
      ? capabilitiesDiscovery.success.value
      : ({
          models: FALLBACK_PI_MODELS,
          usedFallback: true,
          slashCommands: [],
          skills: [],
          detail: Result.isFailure(capabilitiesDiscovery)
            ? capabilitiesDiscovery.failure.message
            : "Pi RPC capability discovery timed out.",
          rpcHealthy: false,
        } satisfies PiCapabilitiesDiscoveryResult);
  const modelFallbackDetail = discoveredCapabilities.usedFallback
    ? discoveredCapabilities.detail
      ? ` Model discovery fell back to Pi default: ${discoveredCapabilities.detail}`
      : " Model discovery fell back to Pi default."
    : "";
  const commandFailureDetail = discoveredCapabilities.commandDetail
    ? ` Command discovery failed: ${discoveredCapabilities.commandDetail}`
    : "";

  const rpcReady = discoveredCapabilities.rpcHealthy;
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discoveredCapabilities.models,
    slashCommands: discoveredCapabilities.slashCommands,
    skills: discoveredCapabilities.skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: rpcReady ? "ready" : "warning",
      auth: rpcReady ? { status: "unknown", label: "Managed by Pi" } : { status: "unknown" },
      message: rpcReady
        ? `Pi CLI is installed. Native Pi chat sessions are available through Pi RPC.${modelFallbackDetail}${commandFailureDetail}`
        : `Pi CLI is installed, but native Pi RPC model discovery is not currently usable.${modelFallbackDetail}${commandFailureDetail}`,
    },
  });
});
