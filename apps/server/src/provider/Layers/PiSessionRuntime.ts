// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/* oxlint-disable typescript/no-this-alias */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  ProviderDriverKind,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { PiRpcJsonlSplitter, PiRpcProcessHandle, killProcessTree } from "./PiRpcProcess.ts";
import { type PiThinkingLevel } from "./PiThinking.ts";
import {
  DEFAULT_PI_RPC_TIMEOUTS,
  PiResumeCursorSchema,
  PiRpcLifecycleError,
  PiRpcRequestFailedError,
  PiRpcSpawnError,
  PiRpcTimeoutError,
  buildPiRpcSpawnArgs,
  buildPiRpcSpawnEnv,
  defaultPiCommand,
  errorMessage,
  isUnknownWorkflowControlCommand,
  parsePiRpcStdoutLine,
  readStringField,
  resolvePiCommand,
  shouldUseShellForPiCommand,
  stripAnsi,
  windowsProcessTreeKillCommand,
  type PiExtensionUiResponseInput,
  type PiResumeCursor,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiWorkflowControlAction,
  type PiWorkflowControlInput,
  type PiWorkflowControlPolicy,
  type PiWorkflowRunCursor,
} from "./PiRpcProtocol.ts";

export { type PiThinkingLevel } from "./PiThinking.ts";

export {
  DEFAULT_PI_RPC_TIMEOUTS,
  PiResumeCursorSchema,
  PiRpcLifecycleError,
  PiRpcRequestFailedError,
  PiRpcSpawnError,
  PiRpcTimeoutError,
  buildPiRpcSpawnArgs,
  buildPiRpcSpawnEnv,
  defaultPiCommand,
  killProcessTree,
  PiRpcJsonlSplitter,
  parsePiRpcStdoutLine,
  resolvePiCommand,
  shouldUseShellForPiCommand,
  stripAnsi,
  windowsProcessTreeKillCommand,
  type PiExtensionUiResponseInput,
  type PiResumeCursor,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiWorkflowControlAction,
  type PiWorkflowControlInput,
  type PiWorkflowControlPolicy,
  type PiWorkflowRunCursor,
};

const PROVIDER = ProviderDriverKind.make("pi");

function formatPiModelValue(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function readPiModelValue(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const model = record.model;

  if (typeof model === "string" && model.trim()) return model.trim();

  if (typeof model === "object" && model !== null) {
    const modelRecord = model as Record<string, unknown>;
    const provider = readTrimmedString(modelRecord.provider);
    const id = readTrimmedString(modelRecord.id) ?? readTrimmedString(modelRecord.modelId);
    if (provider && id) return formatPiModelValue(provider, id);
    if (id) return id;
  }

  const modelId = readTrimmedString(record.modelId);
  if (!modelId) return undefined;
  const provider = readTrimmedString(record.provider);
  return provider ? formatPiModelValue(provider, modelId) : modelId;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface PiSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, PiSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<unknown>;
  }) => Effect.Effect<ProviderTurnStartResult, PiSessionRuntimeError>;
  readonly steer: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<unknown>;
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly abort: () => Effect.Effect<void, PiSessionRuntimeError>;
  readonly getState: Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly getAvailableModels: Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly setThinkingLevel: (
    level: PiThinkingLevel,
  ) => Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly getSessionStats: Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly getMessages: Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly workflowControl: (
    input: PiWorkflowControlInput,
  ) => Effect.Effect<unknown, PiSessionRuntimeError>;
  readonly respondExtensionUi: (
    input: PiExtensionUiResponseInput,
  ) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly consumePreludeLines: Effect.Effect<ReadonlyArray<string>>;
  readonly events: Stream.Stream<PiRpcRuntimeMessage, never>;
  readonly close: Effect.Effect<void>;
}

class PiSessionRuntimeImpl implements PiSessionRuntimeShape {
  readonly events: Stream.Stream<PiRpcRuntimeMessage, never>;
  private process: PiRpcProcessHandle | null = null;
  private status: ProviderSession["status"] = "connecting";
  private sessionFile: string | undefined;
  private currentModel: string | undefined;
  private activeTurnId: TurnId | undefined;
  private turnCounter = 0;
  private readonly timeouts: typeof DEFAULT_PI_RPC_TIMEOUTS;
  private readonly options: PiSessionRuntimeOptions;
  private readonly messages: Queue.Queue<PiRpcRuntimeMessage>;
  private readonly createdAt: string;

  constructor(
    options: PiSessionRuntimeOptions,
    messages: Queue.Queue<PiRpcRuntimeMessage>,
    createdAt: string,
  ) {
    this.options = options;
    this.messages = messages;
    this.createdAt = createdAt;
    this.events = Stream.fromQueue(messages);
    this.sessionFile = options.resumeCursor?.sessionFile;
    this.currentModel = options.model;
    this.timeouts = { ...DEFAULT_PI_RPC_TIMEOUTS, ...options.timeouts };
  }

  readonly start = (): Effect.Effect<ProviderSession, PiSessionRuntimeError> => {
    const self = this;
    return Effect.gen(function* () {
      if (self.process) return yield* self.getSession;
      self.status = "connecting";
      const proc = yield* Effect.tryPromise({
        try: () =>
          PiRpcProcessHandle.spawn({
            command: self.options.binaryPath,
            cwd: self.options.cwd,
            ...(self.options.environment ? { environment: self.options.environment } : {}),
            ...(self.sessionFile ? { sessionFile: self.sessionFile } : {}),
            messages: self.messages,
          }),
        catch: (error) => self.normalizeError(error),
      });
      self.process = proc;
      self.status = "ready";

      const stateResult = yield* self.getState.pipe(Effect.result);
      if (Result.isSuccess(stateResult)) {
        self.applyState(stateResult.success);
      } else if (stateResult.failure._tag === "PiRpcLifecycleError") {
        yield* self.close;
        return yield* Effect.fail(stateResult.failure);
      }

      return yield* self.getSession;
    });
  };

  readonly getSession: Effect.Effect<ProviderSession> = Effect.suspend(() => {
    const self = this;
    return Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        provider: PROVIDER,
        ...(self.options.providerInstanceId
          ? { providerInstanceId: self.options.providerInstanceId }
          : {}),
        status: self.status,
        runtimeMode: self.options.runtimeMode,
        cwd: self.options.cwd,
        ...(self.currentModel ? { model: self.currentModel } : {}),
        threadId: self.options.threadId,
        ...(self.sessionFile
          ? { resumeCursor: { sessionFile: self.sessionFile } satisfies PiResumeCursor }
          : {}),
        ...(self.activeTurnId ? { activeTurnId: self.activeTurnId } : {}),
        createdAt: self.createdAt,
        updatedAt,
      } satisfies ProviderSession;
    });
  });

  readonly prompt = (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<unknown>;
  }): Effect.Effect<ProviderTurnStartResult, PiSessionRuntimeError> => {
    const self = this;
    return Effect.gen(function* () {
      self.status = "running";
      const response = yield* self.requestAndRequireSuccess(
        { type: "prompt", message: input.message, images: input.images ?? [] },
        self.timeouts.prompt,
      );
      const turnId = TurnId.make(
        readStringField(response.data, "turnId") ??
          readStringField(response.data, "id") ??
          `pi-turn-${++self.turnCounter}`,
      );
      self.activeTurnId = turnId;
      self.applyState(response.data);
      self.status = "ready";
      return {
        threadId: self.options.threadId,
        turnId,
        ...(self.sessionFile
          ? { resumeCursor: { sessionFile: self.sessionFile } satisfies PiResumeCursor }
          : {}),
      } satisfies ProviderTurnStartResult;
    });
  };

  readonly steer = (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<unknown>;
  }): Effect.Effect<void, PiSessionRuntimeError> =>
    this.requestVoid(
      { type: "steer", message: input.message, images: input.images ?? [] },
      this.timeouts.request,
    );

  readonly abort = (): Effect.Effect<void, PiSessionRuntimeError> =>
    this.requestVoid({ type: "abort" }, this.timeouts.abort);

  readonly getState: Effect.Effect<unknown, PiSessionRuntimeError> = Effect.suspend(() => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.requestAndRequireSuccess(
        { type: "get_state" },
        self.timeouts.request,
      );
      self.applyState(response.data);
      return response.data;
    });
  });

  readonly getAvailableModels: Effect.Effect<unknown, PiSessionRuntimeError> = Effect.suspend(
    () => {
      const self = this;
      return Effect.gen(function* () {
        const response = yield* self.requestAndRequireSuccess(
          { type: "get_available_models" },
          self.timeouts.request,
        );
        return response.data;
      });
    },
  );

  readonly setModel = (
    provider: string,
    modelId: string,
  ): Effect.Effect<unknown, PiSessionRuntimeError> => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.requestAndRequireSuccess(
        { type: "set_model", provider, modelId },
        self.timeouts.request,
      );
      self.applyState(response.data);
      self.currentModel = readPiModelValue(response.data) ?? formatPiModelValue(provider, modelId);
      return response.data;
    });
  };

  readonly setThinkingLevel = (
    level: PiThinkingLevel,
  ): Effect.Effect<unknown, PiSessionRuntimeError> => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.requestAndRequireSuccess(
        { type: "set_thinking_level", level },
        self.timeouts.request,
      );
      self.applyState(response.data);
      return response.data;
    });
  };

  readonly getSessionStats: Effect.Effect<unknown, PiSessionRuntimeError> = Effect.suspend(() => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.requestAndRequireSuccess(
        { type: "get_session_stats" },
        self.timeouts.request,
      );
      return response.data;
    });
  });

  readonly getMessages: Effect.Effect<unknown, PiSessionRuntimeError> = Effect.suspend(() => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.requestAndRequireSuccess(
        { type: "get_messages" },
        self.timeouts.request,
      );
      return response.data;
    });
  });

  readonly workflowControl = (
    input: PiWorkflowControlInput,
  ): Effect.Effect<unknown, PiSessionRuntimeError> => {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.request(
        { type: "workflow_control", ...input },
        self.timeouts.workflowControl,
      );
      if (response.success) return response.data;
      if (isUnknownWorkflowControlCommand(response.error)) {
        const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
        const fallback = yield* self.requestAndRequireSuccess(
          { type: "prompt", message: `/workflow:control ${payload}` },
          self.timeouts.prompt,
        );
        return fallback.data;
      }
      return yield* Effect.fail(
        new PiRpcRequestFailedError({
          command: response.command,
          ...(response.error ? { error: response.error } : {}),
          data: response.data,
        }),
      );
    });
  };

  readonly respondExtensionUi = (
    input: PiExtensionUiResponseInput,
  ): Effect.Effect<void, PiSessionRuntimeError> =>
    this.send({ type: "extension_ui_response", ...input });

  readonly consumePreludeLines: Effect.Effect<ReadonlyArray<string>> = Effect.sync(
    () => this.process?.consumePreludeLines() ?? [],
  );

  readonly close: Effect.Effect<void> = Effect.promise(async () => {
    this.status = "closed";
    const proc = this.process;
    this.process = null;
    if (proc) await proc.terminate({ attemptAbort: false });
  });

  private send(command: PiRpcCommand): Effect.Effect<void, PiSessionRuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const proc = self.process;
      if (!proc)
        return yield* Effect.fail(
          new PiRpcLifecycleError(`Pi RPC process has not started; cannot send ${command.type}.`),
        );
      return yield* Effect.tryPromise({
        try: () => proc.send(command),
        catch: (error) => self.normalizeError(error),
      });
    });
  }

  private request(
    command: PiRpcCommand,
    timeoutMs: number,
  ): Effect.Effect<PiRpcResponse, PiSessionRuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const proc = self.process;
      if (!proc)
        return yield* Effect.fail(
          new PiRpcLifecycleError(`Pi RPC process has not started; cannot send ${command.type}.`),
        );
      return yield* Effect.tryPromise({
        try: () => proc.request(command, timeoutMs),
        catch: (error) => self.normalizeError(error),
      });
    });
  }

  private requestAndRequireSuccess(
    command: PiRpcCommand,
    timeoutMs: number,
  ): Effect.Effect<PiRpcResponse, PiSessionRuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.request(command, timeoutMs);
      if (!response.success) {
        return yield* Effect.fail(
          new PiRpcRequestFailedError({
            command: response.command,
            ...(response.error ? { error: response.error } : {}),
            data: response.data,
          }),
        );
      }
      return response;
    });
  }

  private requestVoid(
    command: PiRpcCommand,
    timeoutMs: number,
  ): Effect.Effect<void, PiSessionRuntimeError> {
    return Effect.asVoid(this.requestAndRequireSuccess(command, timeoutMs));
  }

  private applyState(data: unknown): void {
    const sessionFile =
      readStringField(data, "sessionFile") ?? readStringField(data, "sessionPath");
    if (sessionFile) {
      this.sessionFile = sessionFile;
      try {
        mkdirSync(dirname(sessionFile), { recursive: true });
      } catch {}
    }

    const model = readPiModelValue(data);
    if (model) this.currentModel = model;
  }

  private normalizeError(error: unknown): PiSessionRuntimeError {
    if (
      error instanceof PiRpcSpawnError ||
      error instanceof PiRpcLifecycleError ||
      error instanceof PiRpcTimeoutError ||
      error instanceof PiRpcRequestFailedError
    ) {
      return error;
    }
    return new PiRpcLifecycleError(errorMessage(error), error);
  }
}

export const makePiSessionRuntime = Effect.fn("makePiSessionRuntime")(function* (
  options: PiSessionRuntimeOptions,
): Effect.fn.Return<PiSessionRuntimeShape> {
  const messages = yield* Queue.unbounded<PiRpcRuntimeMessage>();
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  return new PiSessionRuntimeImpl(options, messages, createdAt);
});
