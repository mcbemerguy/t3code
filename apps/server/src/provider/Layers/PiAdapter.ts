// @effect-diagnostics preferSchemaOverJson:off
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { basePiEvent, PiEventMapper } from "./PiEventMapper.ts";
import type { PiAdapterSessionContext, PiUsageRefreshOptions } from "./PiAdapterTypes.ts";
import { parsePiModelSelection } from "./PiModels.ts";
import { isPiThinkingLevel } from "./PiThinking.ts";
import {
  DEFAULT_PI_RPC_TIMEOUTS,
  PiRpcLifecycleError,
  PiRpcSpawnError,
  makePiSessionRuntime,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "./PiSessionRuntime.ts";
import { cancellationResponse, normalizePiExtensionUiResponse } from "./PiExtensionUi.ts";
import { normalizePiReadThread } from "./PiReadThread.ts";
import { PiUsageState } from "./PiUsage.ts";
import {
  sessionFileFromProviderSession,
  isTerminalWorkflowStatus,
  makePiResumeCursor,
  mergeWorkflowRunCursor,
  parsePiResumeCursor,
} from "./PiWorkflowCursor.ts";
import { parseWorkflowControlPrompt } from "./PiWorkflowArtifacts.ts";
import {
  restorePiWorkflowRuns,
  startPiWorkflowCommandMonitor,
  startPiWorkflowRunMonitor,
  stopWorkflowMonitors,
  type PiWorkflowMonitorOptions,
} from "./PiWorkflowMonitor.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const DEFAULT_USAGE_DEBOUNCE_MS = 50;
const MAX_RETAINED_PENDING_TOOLS = 1024;

function mergeUsageRefreshOptions(
  previous: PiUsageRefreshOptions | undefined,
  next: PiUsageRefreshOptions | undefined,
): PiUsageRefreshOptions | undefined {
  const contextChange =
    previous?.contextChange === "reset" || next?.contextChange === "reset"
      ? "reset"
      : previous?.contextChange === "compaction" || next?.contextChange === "compaction"
        ? "compaction"
        : undefined;
  return contextChange ? { contextChange } : undefined;
}

function pruneRetainedPendingTools(session: PiAdapterSessionContext): void {
  while (session.tools.size > MAX_RETAINED_PENDING_TOOLS) {
    const oldest = session.tools.keys().next();
    if (oldest.done) return;
    session.tools.delete(oldest.value);
  }
}

type PiImageContent = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: PiSessionRuntimeOptions,
  ) => Effect.Effect<PiSessionRuntimeShape, PiSessionRuntimeError, Scope.Scope>;
  readonly usageDebounceMs?: number;
  readonly workflowMonitor?: PiWorkflowMonitorOptions;
}

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly sendActiveTurnInput: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<void, ProviderAdapterError>;
}

function mapPiRuntimeError(
  threadId: ThreadId,
  method: string,
  error: PiSessionRuntimeError,
): ProviderAdapterError {
  if (error instanceof PiRpcSpawnError) {
    return new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: error.message,
      cause: error,
    });
  }
  if (
    error instanceof PiRpcLifecycleError &&
    /process has not started|process.*closed|exited/i.test(error.message)
  ) {
    return new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piConfig: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiAdapterSessionContext>();
  let turnCounter = 0;

  const offer = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const completeTurn = (
    session: PiAdapterSessionContext,
    raw?: PiRpcRuntimeMessage,
    state: "completed" | "failed" | "cancelled" | "interrupted" = "completed",
    detail?: { readonly errorMessage?: string; readonly stopReason?: string },
  ) =>
    Effect.gen(function* () {
      if (session.turnCompleted) return;
      session.turnCompleted = true;
      const rawInput = raw ? { raw } : undefined;
      yield* offer([
        {
          ...basePiEvent(session, rawInput),
          type: "turn.completed",
          payload: {
            state,
            ...(detail?.errorMessage ? { errorMessage: detail.errorMessage } : {}),
            ...(detail?.stopReason ? { stopReason: detail.stopReason } : {}),
          },
        } satisfies ProviderRuntimeEvent,
        {
          ...basePiEvent(session, rawInput),
          type: "session.state.changed",
          payload: {
            state: state === "failed" ? "error" : "ready",
            ...(detail?.errorMessage ? { reason: detail.errorMessage } : {}),
          },
        } satisfies ProviderRuntimeEvent,
      ]);
      delete session.currentTurnId;
      delete session.assistantItemId;
      delete session.reasoningItemId;
    });

  const queueUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
    force = false,
  ) => {
    session.usageRefreshQueued = true;
    session.usageRefreshQueuedForce = session.usageRefreshQueuedForce || force;
    const queuedOptions = mergeUsageRefreshOptions(
      session.usageRefreshQueuedOptions,
      refreshOptions,
    );
    if (queuedOptions) session.usageRefreshQueuedOptions = queuedOptions;
    else delete session.usageRefreshQueuedOptions;
  };

  const flushUsageRefreshWaiters = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.forEach(Array.from(session.usageRefreshWaiters), (waiter) =>
      Deferred.succeed(waiter, undefined),
    ).pipe(Effect.asVoid, Effect.ensuring(Effect.sync(() => session.usageRefreshWaiters.clear())));

  const clearUsageRefreshTimer = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fiber = session.usageRefreshTimerFiber;
      if (!fiber) return;
      delete session.usageRefreshTimerFiber;
      delete session.usageRefreshPendingOptions;
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    });

  const refreshUsage = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions & { readonly force?: boolean },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const sequence = ++session.usageRefreshSequence;
      const startedDuringForcedRefresh =
        refreshOptions?.force !== true && session.forcedUsageRefreshInFlight > 0;
      if (refreshOptions?.force === true) {
        session.latestForcedUsageRefreshSequence = sequence;
        session.forcedUsageRefreshInFlight += 1;
      }
      try {
        const statsResult = yield* session.runtime.getSessionStats.pipe(Effect.result);
        if (Result.isFailure(statsResult)) return;
        if (
          sequence < session.latestForcedUsageRefreshSequence ||
          startedDuringForcedRefresh ||
          session.stopped
        )
          return;
        const usage = session.usageState.update({
          source: "parent",
          stats: statsResult.success,
          ...(refreshOptions?.contextChange ? { contextChange: refreshOptions.contextChange } : {}),
        });
        const usageToEmit =
          usage ?? (refreshOptions?.force === true ? session.usageState.snapshot() : undefined);
        if (!usageToEmit) return;
        yield* offer([
          {
            ...basePiEvent(session),
            type: "thread.token-usage.updated",
            payload: { usage: usageToEmit },
          } satisfies ProviderRuntimeEvent,
        ]);
      } finally {
        if (refreshOptions?.force === true)
          session.forcedUsageRefreshInFlight = Math.max(0, session.forcedUsageRefreshInFlight - 1);
      }
    });

  const runUsageRefreshNow = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions & { readonly force?: boolean },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) return;
      if (session.usageRefreshInFlight) {
        queueUsageRefresh(session, refreshOptions, refreshOptions?.force === true);
        return;
      }

      session.usageRefreshInFlight = true;
      try {
        yield* refreshUsage(session, refreshOptions);
      } finally {
        session.usageRefreshInFlight = false;
      }

      const wasQueued = session.usageRefreshQueued;
      const queuedOptions = session.usageRefreshQueuedOptions;
      const queuedForce = session.usageRefreshQueuedForce;
      session.usageRefreshQueued = false;
      session.usageRefreshQueuedForce = false;
      delete session.usageRefreshQueuedOptions;

      if (wasQueued && !session.stopped) {
        if (queuedForce) {
          yield* runUsageRefreshNow(session, { ...queuedOptions, force: true });
          yield* flushUsageRefreshWaiters(session);
        } else {
          yield* scheduleUsageRefresh(session, queuedOptions);
        }
      }
    });

  const scheduleUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) return;
      if (session.usageRefreshInFlight) {
        queueUsageRefresh(session, refreshOptions);
        return;
      }
      if (session.usageRefreshTimerFiber) {
        const pendingOptions = mergeUsageRefreshOptions(
          session.usageRefreshPendingOptions,
          refreshOptions,
        );
        if (pendingOptions) session.usageRefreshPendingOptions = pendingOptions;
        else delete session.usageRefreshPendingOptions;
        return;
      }

      const debounceMs = options?.usageDebounceMs ?? DEFAULT_USAGE_DEBOUNCE_MS;
      if (debounceMs <= 0) {
        yield* runUsageRefreshNow(session, refreshOptions);
        return;
      }
      if (refreshOptions) session.usageRefreshPendingOptions = refreshOptions;
      else delete session.usageRefreshPendingOptions;
      session.usageRefreshTimerFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(debounceMs));
        const pendingOptions = session.usageRefreshPendingOptions;
        delete session.usageRefreshTimerFiber;
        delete session.usageRefreshPendingOptions;
        yield* runUsageRefreshNow(session, pendingOptions);
      }).pipe(Effect.forkIn(session.scope));
    });

  const forceUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) return;
      const forcedOptions = mergeUsageRefreshOptions(
        mergeUsageRefreshOptions(
          session.usageRefreshPendingOptions,
          session.usageRefreshQueuedOptions,
        ),
        refreshOptions,
      );
      yield* clearUsageRefreshTimer(session);
      session.usageRefreshQueued = false;
      session.usageRefreshQueuedForce = false;
      delete session.usageRefreshQueuedOptions;
      if (session.usageRefreshInFlight) {
        const waiter = yield* Deferred.make<void>();
        session.usageRefreshWaiters.add(waiter);
        queueUsageRefresh(session, forcedOptions, true);
        yield* Deferred.await(waiter);
        return;
      }
      yield* runUsageRefreshNow(session, { ...forcedOptions, force: true });
    });

  const currentResumeCursor = (session: PiAdapterSessionContext) =>
    session.sessionFile
      ? makePiResumeCursor({
          sessionFile: session.sessionFile,
          providerInstanceId: boundInstanceId,
          activeWorkflowRuns: Array.from(session.workflowRuns.values()),
        })
      : undefined;

  const syncSessionFile = (session: PiAdapterSessionContext, providerSession: ProviderSession) => {
    const sessionFile = sessionFileFromProviderSession(providerSession);
    if (sessionFile) session.sessionFile = sessionFile;
  };

  const runtimeSessionWithWorkflowCursor = (session: PiAdapterSessionContext) =>
    session.runtime.getSession.pipe(
      Effect.map((providerSession) => {
        syncSessionFile(session, providerSession);
        const resumeCursor = currentResumeCursor(session);
        return resumeCursor ? { ...providerSession, resumeCursor } : providerSession;
      }),
    );

  const mapper = new PiEventMapper(offer, scheduleUsageRefresh, completeTurn);

  const describeError = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
  };

  const resolveImageAttachment = Effect.fn("resolvePiImageAttachment")(function* (
    method: string,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ): Effect.fn.Return<PiImageContent, ProviderAdapterError> {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image",
      mimeType: attachment.mimeType,
      data: Buffer.from(bytes).toString("base64"),
    };
  });

  const resolveImageAttachments = Effect.fn("resolvePiImageAttachments")(function* (
    method: string,
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<ReadonlyArray<PiImageContent>, ProviderAdapterError> {
    return yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveImageAttachment(method, attachment),
      { concurrency: 1 },
    );
  });

  const requireSession = Effect.fn("requirePiSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped)
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return session;
  });

  const applyModelSelection = Effect.fn("applyPiModelSelection")(function* (
    session: PiAdapterSessionContext,
    modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
    operation: string,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    if (modelSelection?.instanceId !== boundInstanceId) return;
    const selectedThinkingLevel =
      getModelSelectionStringOptionValue(modelSelection, "reasoning") ??
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
    if (selectedThinkingLevel !== undefined && !isPiThinkingLevel(selectedThinkingLevel)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: `Pi thinking level '${selectedThinkingLevel}' is not supported by Pi RPC.`,
      });
    }

    const target = parsePiModelSelection(modelSelection.model);
    if (target) {
      yield* session.runtime
        .setModel(target.provider, target.modelId)
        .pipe(Effect.mapError((cause) => mapPiRuntimeError(session.threadId, "set_model", cause)));
    } else if (modelSelection.model !== "default") {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: `Pi model '${modelSelection.model}' must use the '<provider>/<modelId>' format returned by Pi model discovery.`,
      });
    }

    if (selectedThinkingLevel === undefined) return;
    yield* session.runtime
      .setThinkingLevel(selectedThinkingLevel)
      .pipe(
        Effect.mapError((cause) =>
          mapPiRuntimeError(session.threadId, "set_thinking_level", cause),
        ),
      );
  });

  const settlePendingUserInput = Effect.fn("settlePiPendingUserInput")(function* (
    session: PiAdapterSessionContext,
    requestId: RuntimeRequestId,
    answers: Record<string, unknown>,
  ) {
    session.pendingUserInputs.delete(requestId);
    yield* offer([
      {
        ...basePiEvent(session, { requestId }),
        type: "user-input.resolved",
        payload: { answers },
      } satisfies ProviderRuntimeEvent,
    ]);
  });

  const cancelPendingUserInputs = Effect.fn("cancelPiPendingUserInputs")(function* (
    session: PiAdapterSessionContext,
  ) {
    const pending = Array.from(session.pendingUserInputs.values());
    for (const request of pending) {
      const response = cancellationResponse(request);
      yield* session.runtime.respondExtensionUi(response).pipe(Effect.ignore);
      yield* settlePendingUserInput(session, request.requestId, { ...response });
    }
  });

  const stopSessionInternal = Effect.fn("stopPiSessionInternal")(function* (
    session: PiAdapterSessionContext,
  ) {
    if (session.stopped) return;
    session.stopped = true;
    sessions.delete(session.threadId);
    yield* cancelPendingUserInputs(session);
    yield* clearUsageRefreshTimer(session);
    yield* flushUsageRefreshWaiters(session);
    yield* stopWorkflowMonitors(session);
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    if (session.eventFiber) yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
    yield* offer([
      {
        ...basePiEvent(session),
        type: "session.exited",
        payload: { exitKind: "graceful" },
      } satisfies ProviderRuntimeEvent,
    ]);
  });

  const startSession = (input: ProviderSessionStartInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) yield* stopSessionInternal(existing);

        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const parsedResumeCursor = parsePiResumeCursor(input.resumeCursor, {
          expectedProviderInstanceId: boundInstanceId,
        });
        const runtimeInput: PiSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          binaryPath: piConfig.binaryPath,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(parsedResumeCursor ? { resumeCursor: parsedResumeCursor } : {}),
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          timeouts: DEFAULT_PI_RPC_TIMEOUTS,
        };
        const createRuntime = options?.makeRuntime ?? makePiSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const resumeCursor = parsedResumeCursor;
        const session: PiAdapterSessionContext = {
          threadId: input.threadId,
          cwd: runtimeInput.cwd,
          scope: sessionScope,
          runtime,
          tools: new Map(),
          pendingUserInputs: new Map(),
          workflowRuns: new Map(
            (resumeCursor?.workflows?.activeRuns ?? []).map((run) => [run.runId, run] as const),
          ),
          workflowTails: new Map(),
          workflowRunTurnIds: new Map(),
          workflowMonitorDisposers: new Set(),
          workflowMonitorRunIds: new Set(),
          ...(resumeCursor?.sessionFile ? { sessionFile: resumeCursor.sessionFile } : {}),
          stopped: false,
          turnCompleted: true,
          usageRefreshInFlight: false,
          usageRefreshQueued: false,
          usageRefreshQueuedForce: false,
          usageRefreshWaiters: new Set(),
          usageRefreshSequence: 0,
          latestForcedUsageRefreshSequence: 0,
          forcedUsageRefreshInFlight: 0,
          usageState: new PiUsageState(),
        };
        session.eventFiber = yield* Stream.runForEach(runtime.events, (message) =>
          mapper.handle(session, message),
        ).pipe(Effect.forkChild);

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(
                session.eventFiber ? Fiber.interrupt(session.eventFiber) : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        );
        syncSessionFile(session, started);
        yield* applyModelSelection(session, input.modelSelection, "startSession").pipe(
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(
                session.eventFiber ? Fiber.interrupt(session.eventFiber) : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        );
        sessions.set(input.threadId, session);
        sessionScopeTransferred = true;
        yield* restorePiWorkflowRuns(session, offer, options?.workflowMonitor);
        yield* offer([
          {
            ...basePiEvent(session),
            type: "session.started",
            payload: currentResumeCursor(session) ? { resume: currentResumeCursor(session) } : {},
          } satisfies ProviderRuntimeEvent,
          {
            ...basePiEvent(session),
            type: "thread.started",
            payload: {},
          } satisfies ProviderRuntimeEvent,
          {
            ...basePiEvent(session),
            type: "session.state.changed",
            payload: { state: "ready" },
          } satisfies ProviderRuntimeEvent,
        ]);
        return yield* runtimeSessionWithWorkflowCursor(session);
      }),
    );

  const emitWorkflowControlNotice = (
    session: PiAdapterSessionContext,
    text: string,
    detail: Record<string, unknown>,
  ) =>
    offer([
      {
        ...basePiEvent(session),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: text },
        raw: { source: "pi.workflow.artifact", method: "workflow_control", payload: detail },
      } satisfies ProviderRuntimeEvent,
    ]);

  const runWorkflowControl = Effect.fn("runPiWorkflowControl")(function* (
    session: PiAdapterSessionContext,
    action: "pause" | "resume" | "abort",
    target: string,
    reason: string,
  ) {
    yield* session.runtime
      .workflowControl({
        action,
        target,
        reason,
        ...(action === "resume" ? { policy: "continue-existing-session" as const } : {}),
      })
      .pipe(
        Effect.mapError((cause) => mapPiRuntimeError(session.threadId, "workflow_control", cause)),
      );
    const status = action === "resume" ? "recovering" : action === "pause" ? "paused" : "aborting";
    const previous = session.workflowRuns.get(target);
    if (action === "abort" && !previous) {
      session.workflowRuns.delete(target);
      session.workflowTails.delete(target);
      session.workflowRunTurnIds.delete(target);
    } else {
      session.workflowRuns.set(
        target,
        mergeWorkflowRunCursor(previous, {
          runId: target,
          lastSequence: previous?.lastSequence ?? 0,
          status,
        }),
      );
    }
    yield* emitWorkflowControlNotice(session, `Workflow ${target} ${action} requested.`, {
      action,
      target,
      status,
    });
    const controlledRun = session.workflowRuns.get(target);
    if (controlledRun)
      yield* startPiWorkflowRunMonitor(session, offer, controlledRun, options?.workflowMonitor);
  });

  const handleWorkflowControlPrompt = Effect.fn("handlePiWorkflowControlPrompt")(function* (
    session: PiAdapterSessionContext,
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<ProviderTurnStartResult | undefined, ProviderAdapterError> {
    const parsed = parseWorkflowControlPrompt(input.input ?? "");
    if (!parsed) return undefined;
    const targets = parsed.target
      ? [parsed.target]
      : Array.from(session.workflowRuns.values())
          .filter((run) => !isTerminalWorkflowStatus(run.status))
          .map((run) => run.runId);
    if (targets.length === 0) {
      yield* emitWorkflowControlNotice(
        session,
        `No active workflow runs available to ${parsed.action}.`,
        {
          action: parsed.action,
        },
      );
    } else {
      for (const target of targets) {
        yield* runWorkflowControl(
          session,
          parsed.action,
          target,
          `User requested workflow ${parsed.action} from t3code.`,
        );
      }
    }
    const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
    return {
      threadId: input.threadId,
      turnId,
      ...(currentResumeCursor(session) ? { resumeCursor: currentResumeCursor(session) } : {}),
    };
  });

  const sendTurn = Effect.fn("sendPiTurn")(function* (
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<ProviderTurnStartResult, ProviderAdapterError> {
    const session = yield* requireSession(input.threadId);
    const controlResult = yield* handleWorkflowControlPrompt(session, input);
    if (controlResult) {
      yield* forceUsageRefresh(session);
      return controlResult;
    }

    if (!session.turnCompleted) {
      const images = yield* resolveImageAttachments("turn/start", input);
      yield* session.runtime
        .steer({ message: input.input ?? "", images })
        .pipe(Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "steer", cause)));
      return {
        threadId: input.threadId,
        turnId: session.currentTurnId ?? TurnId.make(`pi-turn-${++turnCounter}`),
      };
    }

    const images = yield* resolveImageAttachments("turn/start", input);
    yield* applyModelSelection(session, input.modelSelection, "sendTurn");

    const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
    pruneRetainedPendingTools(session);
    session.currentTurnId = turnId;
    session.latestTurnId = turnId;
    session.turnCompleted = false;
    yield* offer([
      { ...basePiEvent(session), type: "turn.started", payload: {} } satisfies ProviderRuntimeEvent,
      {
        ...basePiEvent(session),
        type: "session.state.changed",
        payload: { state: "running" },
      } satisfies ProviderRuntimeEvent,
    ]);
    yield* startPiWorkflowCommandMonitor(
      session,
      offer,
      input.input ?? "",
      options?.workflowMonitor,
    );
    const result = yield* Effect.gen(function* () {
      const providerResult = yield* session.runtime
        .prompt({ message: input.input ?? "", images })
        .pipe(
          Effect.tap((promptResult) =>
            Effect.sync(() => {
              const cursor = parsePiResumeCursor(promptResult.resumeCursor);
              if (cursor?.sessionFile) session.sessionFile = cursor.sessionFile;
            }),
          ),
          Effect.tapError((cause) =>
            completeTurn(session, undefined, "failed", {
              errorMessage: describeError(cause, "Pi prompt failed"),
            }),
          ),
          Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "prompt", cause)),
        );
      for (let index = 0; index < 5 && !session.turnCompleted; index += 1) {
        yield* Effect.yieldNow;
      }
      return providerResult;
    }).pipe(Effect.ensuring(forceUsageRefresh(session)));
    return {
      threadId: result.threadId,
      turnId,
      ...(currentResumeCursor(session) ? { resumeCursor: currentResumeCursor(session) } : {}),
    };
  });

  const sendActiveTurnInput = Effect.fn("sendPiActiveTurnInput")(function* (
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    const session = yield* requireSession(input.threadId);
    const images = yield* resolveImageAttachments("turn/start", input);
    yield* session.runtime
      .steer({ message: input.input ?? "", images })
      .pipe(Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "steer", cause)));
  });

  const pauseActiveWorkflows = (session: PiAdapterSessionContext) =>
    Effect.gen(function* () {
      const runs = Array.from(session.workflowRuns.values()).filter(
        (run) => !isTerminalWorkflowStatus(run.status),
      );
      if (runs.length === 0) return false;
      for (const run of runs) {
        yield* runWorkflowControl(
          session,
          "pause",
          run.runId,
          "User requested workflow interruption from t3code.",
        );
      }
      yield* emitWorkflowControlNotice(
        session,
        "Workflow pause requested. Use /workflow:resume or /workflow:abort to continue or terminate it explicitly.",
        { activeWorkflowRuns: runs.map((run) => run.runId) },
      );
      return true;
    });

  const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        pauseActiveWorkflows(session).pipe(
          Effect.flatMap((pausedWorkflow) => {
            if (pausedWorkflow) return cancelPendingUserInputs(session);
            return cancelPendingUserInputs(session).pipe(
              Effect.andThen(session.runtime.abort()),
              Effect.tap(() =>
                offer([
                  {
                    ...basePiEvent(session),
                    type: "turn.aborted",
                    payload: { reason: "Interrupted by user" },
                  } satisfies ProviderRuntimeEvent,
                ]),
              ),
              Effect.andThen(completeTurn(session, undefined, "interrupted")),
            );
          }),
        ),
      ),
      Effect.mapError((cause): ProviderAdapterError => {
        if (cause._tag.startsWith("ProviderAdapter")) return cause as ProviderAdapterError;
        return mapPiRuntimeError(threadId, "abort", cause as PiSessionRuntimeError);
      }),
    );

  const readThread = (threadId: ThreadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.getMessages),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapPiRuntimeError(threadId, "get_messages", cause),
      ),
      Effect.map((messages) => normalizePiReadThread(threadId, messages)),
    );

  const rollbackThread = () =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "rollbackThread",
        detail:
          "Native Pi rollback is unsupported because Pi RPC does not expose a safe thread rollback API.",
      }),
    );

  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (session) yield* stopSessionInternal(session);
    });
  const stopAll = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue)), Effect.ignore),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    sendActiveTurnInput,
    interruptTurn,
    respondToRequest: () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail:
            "Native Pi does not expose approval request responses; extension UI prompts use respondToUserInput instead.",
        }),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const pending = session.pendingUserInputs.get(runtimeRequestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToUserInput",
                detail: `Unknown Pi extension UI request '${requestId}'.`,
              });
            }
            const response = normalizePiExtensionUiResponse(pending, answers);
            yield* session.runtime
              .respondExtensionUi(response)
              .pipe(
                Effect.mapError((cause) =>
                  mapPiRuntimeError(threadId, "extension_ui_response", cause),
                ),
              );
            yield* settlePendingUserInput(session, pending.requestId, answers);
          }),
        ),
      ),
    stopSession,
    listSessions: () =>
      Effect.forEach(
        Array.from(sessions.values()).filter((session) => !session.stopped),
        (session) => runtimeSessionWithWorkflowCursor(session),
        { concurrency: 1 },
      ),
    hasSession: (threadId) =>
      Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped)),
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});
