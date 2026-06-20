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
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
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
import type {
  PiAdapterSessionContext,
  PiAdapterTimeouts,
  PiUsageRefreshOptions,
} from "./PiAdapterTypes.ts";
import { parsePiModelSelection } from "./PiModels.ts";
import { isPiThinkingLevel } from "./PiThinking.ts";
import {
  DEFAULT_PI_RPC_TIMEOUTS,
  PiRpcLifecycleError,
  PiRpcSpawnError,
  PiRpcTimeoutError,
  makePiSessionRuntime,
  type PiRpcProcessStatus,
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
export const DEFAULT_PI_ADAPTER_TIMEOUTS: PiAdapterTimeouts = {
  interruptAbortWatchdogMs: 2_500,
  noEventWarningMs: 30_000,
  noEventHardRecoveryMs: 120_000,
};
const MAX_RETAINED_COMPLETED_PROMPTS = 1024;
const MAX_RETAINED_COMPLETED_TURNS = 1024;

interface PiCompactCommandInput {
  readonly customInstructions?: string;
}

function isPlainWorkflowContinuationMessage(input: string): boolean {
  return /^(?:continue|resume|proceed|go on|keep going|yes|ok|okay)\b/i.test(input.trim());
}

function parsePiCompactCommand(input: string | undefined): PiCompactCommandInput | undefined {
  const text = input?.trim();
  if (!text) return undefined;
  if (text === "/compact") return {};
  if (!text.startsWith("/compact ")) return undefined;
  const customInstructions = text.slice("/compact ".length).trim();
  return customInstructions ? { customInstructions } : {};
}

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

function pruneRetainedCompletedPrompts(session: PiAdapterSessionContext): void {
  while (session.completedPromptEventIds.size > MAX_RETAINED_COMPLETED_PROMPTS) {
    const oldest = session.completedPromptEventIds.keys().next();
    if (oldest.done) return;
    session.completedPromptEventIds.delete(oldest.value);
  }
}

function pruneRetainedCompletedTurns(session: PiAdapterSessionContext): void {
  while (session.completedTurnIds.size > MAX_RETAINED_COMPLETED_TURNS) {
    const oldest = session.completedTurnIds.keys().next();
    if (oldest.done) return;
    session.completedTurnIds.delete(oldest.value);
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
  readonly timeouts?: Partial<PiAdapterTimeouts>;
}

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly sendActiveTurnInput: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<void, ProviderAdapterError>;
}

function isRuntimeClosedHealth(health: PiRpcProcessStatus): boolean {
  return health.state === "closed" || health.state === "error";
}

function runtimeClosedReason(operation: string, health: PiRpcProcessStatus): string {
  const code = health.closeCode ?? health.exitCode;
  const signal = health.closeSignal ?? health.exitSignal;
  const detail = [
    code !== undefined && code !== null ? `code=${code}` : undefined,
    signal ? `signal=${signal}` : undefined,
    health.error ? `error=${health.error}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `Pi RPC runtime was ${health.state} before ${operation}${detail ? ` (${detail})` : ""}.`;
}

function isClosedBeforeDeliveryError(
  error: unknown,
  command: string,
): error is PiRpcLifecycleError {
  if (!(error instanceof PiRpcLifecycleError)) return false;
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(process exited before ${escaped} could be sent|stdin is not writable before ${escaped} could be sent|process has not started; cannot send ${escaped})`,
    "i",
  ).test(error.message);
}

function isClosedRuntimeLifecycleError(error: unknown): error is PiRpcLifecycleError {
  return (
    error instanceof PiRpcLifecycleError &&
    /(process exited|stdin is not writable|process has not started|process.*closed|exited=true|closed=true)/i.test(
      error.message,
    )
  );
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
  const sessionStates = new Map<ThreadId, string>();
  const pendingRuntimeTextDeltas = new Map<ThreadId, ProviderRuntimeEvent>();
  const adapterTimeouts: PiAdapterTimeouts = {
    ...DEFAULT_PI_ADAPTER_TIMEOUTS,
    ...options?.timeouts,
  };
  let turnCounter = 0;

  const clearPendingRuntimeTextDelta = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.sync(() => {
      pendingRuntimeTextDeltas.delete(threadId);
    });

  const flushPendingRuntimeTextDelta = (threadId: ThreadId): Effect.Effect<void> => {
    const pending = pendingRuntimeTextDeltas.get(threadId);
    if (!pending) return Effect.void;
    pendingRuntimeTextDeltas.delete(threadId);
    return Queue.offerAll(runtimeEventQueue, [pending]).pipe(Effect.asVoid);
  };

  const isCoalescibleTextDelta = (event: ProviderRuntimeEvent): boolean =>
    event.type === "content.delta" &&
    (event.payload.streamKind === "assistant_text" ||
      event.payload.streamKind === "reasoning_text");

  const canMergeTextDeltas = (
    previous: ProviderRuntimeEvent,
    next: ProviderRuntimeEvent,
  ): boolean =>
    previous.type === "content.delta" &&
    next.type === "content.delta" &&
    previous.threadId === next.threadId &&
    previous.turnId === next.turnId &&
    previous.itemId === next.itemId &&
    previous.payload.streamKind === next.payload.streamKind;

  const mergeTextDeltas = (
    previous: ProviderRuntimeEvent,
    next: ProviderRuntimeEvent,
  ): ProviderRuntimeEvent => {
    if (previous.type !== "content.delta" || next.type !== "content.delta") return next;
    return {
      ...previous,
      createdAt: next.createdAt,
      payload: {
        ...previous.payload,
        delta: `${previous.payload.delta}${next.payload.delta}`,
      },
      raw: next.raw,
    } satisfies ProviderRuntimeEvent;
  };

  const shouldEmitEvent = (event: ProviderRuntimeEvent): boolean => {
    if (event.type === "session.exited") {
      sessionStates.delete(event.threadId);
      return true;
    }
    if (event.type !== "session.state.changed") return true;
    const previous = sessionStates.get(event.threadId);
    if (previous === event.payload.state) return false;
    sessionStates.set(event.threadId, event.payload.state);
    return true;
  };

  const offer = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.gen(function* () {
      const ready: Array<ProviderRuntimeEvent> = [];
      for (const event of events) {
        if (!shouldEmitEvent(event)) continue;
        const pendingRuntimeTextDelta = pendingRuntimeTextDeltas.get(event.threadId);
        if (pendingRuntimeTextDelta) {
          pendingRuntimeTextDeltas.delete(event.threadId);
          ready.push(pendingRuntimeTextDelta);
        }
        ready.push(event);
      }
      if (ready.length > 0) yield* Queue.offerAll(runtimeEventQueue, ready).pipe(Effect.asVoid);
    });

  const offerRuntimeEvents =
    (session: PiAdapterSessionContext) => (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      Effect.gen(function* () {
        const ready: Array<ProviderRuntimeEvent> = [];
        let pendingTextDelta = pendingRuntimeTextDeltas.get(session.threadId);
        for (const event of events) {
          if (!shouldEmitEvent(event)) continue;
          if (isCoalescibleTextDelta(event)) {
            if (pendingTextDelta && canMergeTextDeltas(pendingTextDelta, event)) {
              pendingTextDelta = mergeTextDeltas(pendingTextDelta, event);
            } else {
              if (pendingTextDelta) ready.push(pendingTextDelta);
              pendingTextDelta = event;
            }
            continue;
          }
          if (pendingTextDelta) {
            ready.push(pendingTextDelta);
            pendingTextDelta = undefined;
          }
          ready.push(event);
        }
        if (pendingTextDelta) pendingRuntimeTextDeltas.set(session.threadId, pendingTextDelta);
        else pendingRuntimeTextDeltas.delete(session.threadId);
        if (ready.length > 0) yield* Queue.offerAll(runtimeEventQueue, ready).pipe(Effect.asVoid);
      });

  const clearNoEventWatchdog = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fiber = session.noEventWatchdogFiber;
      delete session.noEventWatchdogFiber;
      session.noEventWarningEmitted = false;
      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    });

  const completeTurn = (
    session: PiAdapterSessionContext,
    raw?: PiRpcRuntimeMessage,
    state: "completed" | "failed" | "cancelled" | "interrupted" = "completed",
    detail?: { readonly errorMessage?: string; readonly stopReason?: string },
  ) =>
    Effect.gen(function* () {
      const turnId = session.currentTurnId ?? session.latestTurnId;
      if (turnId && session.completedTurnIds.has(turnId)) return;
      if (session.turnCompleted) return;
      yield* clearNoEventWatchdog(session);
      session.turnCompleted = true;
      if (turnId) {
        session.completedTurnIds.add(turnId);
        pruneRetainedCompletedTurns(session);
        session.cancellingTurnIds.delete(turnId);
      }
      session.promptAccepted = false;
      session.quarantinePromptEventsUntilAcceptedDrain = false;
      session.requirePromptStartBeforeCompletion = false;
      if (session.activePromptEventId) {
        session.completedPromptEventIds.add(session.activePromptEventId);
        pruneRetainedCompletedPrompts(session);
        delete session.activePromptEventId;
      }
      const rawInput = {
        ...(raw ? { raw } : {}),
        ...(turnId ? { turnId } : {}),
      };
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
      delete session.assistantItemText;
      delete session.reasoningItemId;
    });

  const workflowMonitorOptions = (): PiWorkflowMonitorOptions => ({
    ...options?.workflowMonitor,
    completeTurn,
  });

  const enqueueUsageRefreshRequest = (
    session: PiAdapterSessionContext,
    refreshOptions: PiUsageRefreshOptions | undefined,
    force: boolean,
    waiter?: Deferred.Deferred<void>,
  ) => {
    session.usageRefreshQueue.push({
      ...(refreshOptions ? { options: refreshOptions } : {}),
      force,
      ...(waiter ? { waiter } : {}),
    });
  };

  const compactUsageRefreshQueueForForcedRequest = (
    session: PiAdapterSessionContext,
    refreshOptions: PiUsageRefreshOptions | undefined,
  ): {
    readonly options?: PiUsageRefreshOptions;
    readonly droppedWaiters: ReadonlyArray<Deferred.Deferred<void>>;
  } => {
    let pendingOptions = refreshOptions;
    const compactedQueue: typeof session.usageRefreshQueue = [];
    const droppedWaiters: Array<Deferred.Deferred<void>> = [];

    for (const request of session.usageRefreshQueue) {
      if (!request.force) {
        pendingOptions = mergeUsageRefreshOptions(pendingOptions, request.options);
        if (request.waiter) droppedWaiters.push(request.waiter);
        continue;
      }

      const options = mergeUsageRefreshOptions(request.options, pendingOptions);
      compactedQueue.push({
        ...(options ? { options } : {}),
        force: true,
        ...(request.waiter ? { waiter: request.waiter } : {}),
      });
      pendingOptions = undefined;
    }

    session.usageRefreshQueue.length = 0;
    session.usageRefreshQueue.push(...compactedQueue);
    return {
      ...(pendingOptions ? { options: pendingOptions } : {}),
      droppedWaiters,
    };
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

  const settleUsageRefreshWaiter = (
    session: PiAdapterSessionContext,
    waiter: Deferred.Deferred<void>,
  ): Effect.Effect<void> =>
    Deferred.succeed(waiter, undefined).pipe(
      Effect.asVoid,
      Effect.ensuring(Effect.sync(() => session.usageRefreshWaiters.delete(waiter))),
    );

  const drainUsageRefreshQueue = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped || session.usageRefreshInFlight) return;
      session.usageRefreshInFlight = true;
      try {
        while (!session.stopped) {
          const request = session.usageRefreshQueue.shift();
          if (!request) return;
          try {
            yield* refreshUsage(session, { ...request.options, force: request.force });
          } finally {
            if (request.waiter) yield* settleUsageRefreshWaiter(session, request.waiter);
          }
        }
      } finally {
        session.usageRefreshInFlight = false;
      }
    });

  const ensureUsageRefreshDraining = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped || session.usageRefreshInFlight || session.usageRefreshDrainFiber) return;
      session.usageRefreshDrainFiber = yield* drainUsageRefreshQueue(session).pipe(
        Effect.ensuring(Effect.sync(() => delete session.usageRefreshDrainFiber)),
        Effect.forkIn(session.scope),
      );
    });

  const enqueueUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
    force = false,
    waiter?: Deferred.Deferred<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) return;
      enqueueUsageRefreshRequest(session, refreshOptions, force, waiter);
      yield* ensureUsageRefreshDraining(session);
    });

  const enqueueForcedUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
    waiter?: Deferred.Deferred<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) {
        if (waiter) yield* Deferred.succeed(waiter, undefined).pipe(Effect.asVoid);
        return;
      }
      const timerOptions = mergeUsageRefreshOptions(
        session.usageRefreshPendingOptions,
        refreshOptions,
      );
      yield* clearUsageRefreshTimer(session);
      const { options: forcedOptions, droppedWaiters } = session.usageRefreshInFlight
        ? compactUsageRefreshQueueForForcedRequest(session, timerOptions)
        : { ...(timerOptions ? { options: timerOptions } : {}), droppedWaiters: [] };
      for (const droppedWaiter of droppedWaiters) {
        yield* settleUsageRefreshWaiter(session, droppedWaiter);
      }
      if (session.stopped) {
        if (waiter) yield* Deferred.succeed(waiter, undefined).pipe(Effect.asVoid);
        return;
      }
      if (waiter) session.usageRefreshWaiters.add(waiter);
      yield* enqueueUsageRefresh(session, forcedOptions, true, waiter);
    });

  const scheduleForcedUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
  ): Effect.Effect<void> => enqueueForcedUsageRefresh(session, refreshOptions);

  const scheduleUsageRefresh = (
    session: PiAdapterSessionContext,
    refreshOptions?: PiUsageRefreshOptions,
    force = false,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.stopped) return;
      if (force) {
        yield* scheduleForcedUsageRefresh(session, refreshOptions);
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
        yield* enqueueUsageRefresh(session, refreshOptions);
        return;
      }
      if (refreshOptions) session.usageRefreshPendingOptions = refreshOptions;
      else delete session.usageRefreshPendingOptions;
      session.usageRefreshTimerFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(debounceMs));
        const pendingOptions = session.usageRefreshPendingOptions;
        delete session.usageRefreshTimerFiber;
        delete session.usageRefreshPendingOptions;
        yield* enqueueUsageRefresh(session, pendingOptions);
      }).pipe(Effect.forkIn(session.scope));
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

  const createRuntime = options?.makeRuntime ?? makePiSessionRuntime;

  const forkRuntimeEvents = (session: PiAdapterSessionContext, runtime: PiSessionRuntimeShape) => {
    const mapper = new PiEventMapper(
      offerRuntimeEvents(session),
      scheduleUsageRefresh,
      completeTurn,
    );
    return Stream.runForEach(Stream.chunks(runtime.events), (messages) =>
      Effect.gen(function* () {
        for (const message of messages) {
          if (message.kind === "process.closed") {
            if (!session.stopped && !session.runtimeRecovery) {
              yield* markRuntimeForRecovery(
                session,
                runtimeClosedReason("the next operation", message.status),
                { skipEventFiberInterrupt: true, skipRuntimeClose: true },
              );
            }
            continue;
          }
          if (message.kind === "event") {
            session.turnActivitySequence += 1;
            session.noEventWarningEmitted = false;
          }
          yield* mapper.handle(session, message);
        }
        yield* flushPendingRuntimeTextDelta(session.threadId);
      }),
    ).pipe(
      Effect.ensuring(clearPendingRuntimeTextDelta(session.threadId)),
      Effect.forkIn(session.scope),
    );
  };

  const emitRuntimeRecoveryError = (
    session: PiAdapterSessionContext,
    message: string,
    detail?: Record<string, unknown>,
  ) =>
    offer([
      {
        ...basePiEvent(session),
        type: "runtime.error",
        payload: {
          message,
          class: "provider_error",
          detail: { diagnosticKind: "pi.missingResumeCursor", ...detail },
        },
      } satisfies ProviderRuntimeEvent,
      {
        ...basePiEvent(session),
        type: "session.state.changed",
        payload: { state: "error", reason: message },
      } satisfies ProviderRuntimeEvent,
    ]);

  const markRuntimeForRecovery = Effect.fn("markPiRuntimeForRecovery")(function* (
    session: PiAdapterSessionContext,
    reason: string,
    options?: {
      readonly skipEventFiberInterrupt?: boolean;
      readonly skipRuntimeClose?: boolean;
    },
  ) {
    if (session.runtimeRecovery) return;
    const providerSession = yield* session.runtime.getSession;
    syncSessionFile(session, providerSession);
    const resumeCursor = currentResumeCursor(session);
    const discardedAt = DateTime.formatIso(yield* DateTime.now);
    if (resumeCursor) {
      session.runtimeOptions = {
        ...session.runtimeOptions,
        resumeCursor,
        ...(providerSession.model ? { model: providerSession.model } : {}),
      };
    }
    session.runtimeRecovery = {
      reason,
      discardedAt,
      ...(resumeCursor ? { resumeCursor } : { missingResumeErrorEmitted: true }),
    };
    if (session.eventFiber && !options?.skipEventFiberInterrupt) {
      yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
      delete session.eventFiber;
    }
    yield* clearNoEventWatchdog(session);
    yield* stopWorkflowMonitors(session);
    if (!options?.skipRuntimeClose) yield* session.runtime.close.pipe(Effect.ignore);
    if (resumeCursor) {
      yield* offer([
        {
          ...basePiEvent(session),
          type: "runtime.warning",
          payload: {
            message:
              "Pi RPC became unavailable; T3 will restart from the saved Pi session before the next request. The previous prompt is not being replayed.",
            detail: {
              diagnosticKind: "pi.rpcDiscardedForRecovery",
              reason,
              sessionFile: resumeCursor.sessionFile,
              discardedAt,
            },
          },
        } satisfies ProviderRuntimeEvent,
      ]);
      return;
    }
    yield* emitRuntimeRecoveryError(
      session,
      "Pi RPC became unavailable and no saved Pi session file is available. Start or recover the thread explicitly to avoid creating an unrelated Pi conversation.",
      { reason, discardedAt },
    );
  });

  const discardRuntimeForRecovery = Effect.fn("discardPiRuntimeForRecovery")(function* (
    session: PiAdapterSessionContext,
    reason: string,
  ) {
    return yield* session.runtimeRecoveryLock.withPermits(1)(
      markRuntimeForRecovery(session, reason),
    );
  });

  const turnStillRunning = (session: PiAdapterSessionContext, turnId: TurnId): boolean =>
    !session.stopped &&
    !session.turnCompleted &&
    session.currentTurnId === turnId &&
    !session.completedTurnIds.has(turnId);

  const activeToolsForTurn = (session: PiAdapterSessionContext, turnId: TurnId) =>
    Array.from(session.tools.values()).filter((tool) => tool.turnId === turnId);

  const activeToolNames = (session: PiAdapterSessionContext, turnId: TurnId) =>
    activeToolsForTurn(session, turnId)
      .map((tool) => tool.toolName)
      .filter((name, index, names) => names.indexOf(name) === index);

  const activeToolSummary = (session: PiAdapterSessionContext, turnId: TurnId) => {
    const names = activeToolNames(session, turnId);
    if (names.length === 0) return undefined;
    if (names.length === 1) return names[0];
    const shown = names.slice(0, 3).join(", ");
    const remaining = names.length - 3;
    return remaining > 0 ? `${shown}, and ${remaining} more` : shown;
  };

  const startNoEventWatchdog = Effect.fn("startPiNoEventWatchdog")(function* (
    session: PiAdapterSessionContext,
    turnId: TurnId,
  ) {
    if (!turnStillRunning(session, turnId)) return;
    if (adapterTimeouts.noEventWarningMs <= 0 || adapterTimeouts.noEventHardRecoveryMs <= 0) return;
    const warningMs = adapterTimeouts.noEventWarningMs;
    const hardRecoveryMs = Math.max(adapterTimeouts.noEventHardRecoveryMs, warningMs);
    yield* clearNoEventWatchdog(session);
    session.noEventWarningEmitted = false;
    session.noEventWatchdogFiber = yield* Effect.gen(function* () {
      let observedSequence = session.turnActivitySequence;
      while (turnStillRunning(session, turnId)) {
        yield* Effect.sleep(Duration.millis(warningMs));
        if (!turnStillRunning(session, turnId)) return;
        if (session.turnActivitySequence !== observedSequence) {
          observedSequence = session.turnActivitySequence;
          session.noEventWarningEmitted = false;
          continue;
        }
        if (!session.noEventWarningEmitted) {
          session.noEventWarningEmitted = true;
          const toolSummary = activeToolSummary(session, turnId);
          yield* offer([
            {
              ...basePiEvent(session, { turnId }),
              type: "runtime.warning",
              payload: {
                message: toolSummary
                  ? `Pi is still running ${toolSummary} but has not produced events for ${warningMs}ms. The turn is still running; Stop remains available if you want T3 to interrupt it.`
                  : "Pi accepted the prompt but has not produced any events yet. The turn is still running; Stop remains available if you want T3 to interrupt or recover it.",
                detail: {
                  diagnosticKind: toolSummary ? "pi.activeToolNoEventWarning" : "pi.noEventWarning",
                  timeoutMs: warningMs,
                  hardRecoveryMs,
                  ...(toolSummary
                    ? {
                        activeToolCount: activeToolsForTurn(session, turnId).length,
                        activeToolNames: activeToolNames(session, turnId),
                      }
                    : {}),
                },
              },
            } satisfies ProviderRuntimeEvent,
          ]);
        }
        yield* Effect.sleep(Duration.millis(hardRecoveryMs - warningMs));
        if (!turnStillRunning(session, turnId)) return;
        if (session.turnActivitySequence !== observedSequence) {
          observedSequence = session.turnActivitySequence;
          session.noEventWarningEmitted = false;
          continue;
        }
        const activeTools = activeToolsForTurn(session, turnId);
        if (activeTools.length > 0) {
          const toolSummary = activeToolSummary(session, turnId) ?? "an active tool";
          session.noEventWarningEmitted = true;
          yield* offer([
            {
              ...basePiEvent(session, { turnId }),
              type: "runtime.warning",
              payload: {
                message: `Pi is still running ${toolSummary} but has not produced events for ${hardRecoveryMs}ms. T3 will not auto-recover while Pi tools are active; Stop remains available if you want T3 to interrupt it.`,
                detail: {
                  diagnosticKind: "pi.activeToolNoEventWarning",
                  timeoutMs: hardRecoveryMs,
                  activeToolCount: activeTools.length,
                  activeToolNames: activeToolNames(session, turnId),
                },
              },
            } satisfies ProviderRuntimeEvent,
          ]);
          continue;
        }
        delete session.noEventWatchdogFiber;
        session.noEventWarningEmitted = false;
        yield* cancelPendingUserInputs(session);
        session.nextTurnRequiresPromptStart = true;
        yield* completeTurn(session, undefined, "failed", {
          errorMessage: `Pi accepted the prompt but produced no events for ${hardRecoveryMs}ms.`,
          stopReason: "no_event_stall",
        });
        yield* discardRuntimeForRecovery(
          session,
          `Pi RPC produced no events for ${hardRecoveryMs}ms after prompt acceptance.`,
        );
        return;
      }
    }).pipe(Effect.forkIn(session.scope));
  });

  const ensureRuntimeReady = Effect.fn("ensurePiRuntimeReady")(function* (
    session: PiAdapterSessionContext,
    operation: string,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    return yield* session.runtimeRecoveryLock.withPermits(1)(
      Effect.gen(function* () {
        let recovery = session.runtimeRecovery;
        if (!recovery) {
          const health = yield* session.runtime.getHealth;
          if (!isRuntimeClosedHealth(health)) return;
          yield* markRuntimeForRecovery(session, runtimeClosedReason(operation, health));
          recovery = session.runtimeRecovery;
        }
        if (!recovery) return;
        if (!recovery.resumeCursor) {
          const message =
            "Cannot continue this Pi thread because the previous Pi RPC runtime was discarded without a durable session file. Start or recover the thread explicitly.";
          if (!recovery.missingResumeErrorEmitted) {
            session.runtimeRecovery = { ...recovery, missingResumeErrorEmitted: true };
            yield* emitRuntimeRecoveryError(session, message, {
              operation,
              reason: recovery.reason,
              discardedAt: recovery.discardedAt,
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: operation,
            detail: message,
          });
        }

        if (session.eventFiber) {
          yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
          delete session.eventFiber;
        }
        const runtimeInput: PiSessionRuntimeOptions = {
          ...session.runtimeOptions,
          resumeCursor: recovery.resumeCursor,
        };
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, session.scope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: session.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        session.runtime = runtime;
        session.runtimeOptions = runtimeInput;
        session.eventFiber = yield* forkRuntimeEvents(session, runtime);
        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: session.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(
                session.eventFiber ? Fiber.interrupt(session.eventFiber) : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        );
        syncSessionFile(session, started);
        const resumeCursor = currentResumeCursor(session) ?? recovery.resumeCursor;
        if (resumeCursor) session.runtimeOptions = { ...session.runtimeOptions, resumeCursor };
        delete session.runtimeRecovery;
        yield* restorePiWorkflowRuns(session, offer, workflowMonitorOptions());
        yield* offer([
          {
            ...basePiEvent(session),
            type: "runtime.warning",
            payload: {
              message: "Restarted Pi RPC from the saved Pi session after it became unresponsive.",
              detail: {
                diagnosticKind: "pi.rpcRestartedFromResumeCursor",
                operation,
                reason: recovery.reason,
                sessionFile: resumeCursor.sessionFile,
                discardedAt: recovery.discardedAt,
              },
            },
          } satisfies ProviderRuntimeEvent,
          {
            ...basePiEvent(session),
            type: "session.started",
            payload: { resume: resumeCursor },
          } satisfies ProviderRuntimeEvent,
          {
            ...basePiEvent(session),
            type: "session.state.changed",
            payload: { state: "ready" },
          } satisfies ProviderRuntimeEvent,
        ]);
      }),
    );
  });

  const describeError = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
  };

  const emitLocalInterruptAbortWarning = (
    session: PiAdapterSessionContext,
    interruptedTurnId: TurnId | undefined,
    reason: string,
  ) =>
    offer([
      {
        ...basePiEvent(session, interruptedTurnId ? { turnId: interruptedTurnId } : undefined),
        type: "runtime.warning",
        payload: {
          message:
            "T3 interrupted the turn locally, but Pi RPC did not acknowledge abort. The thread remains usable and late Pi events from the interrupted turn will be ignored.",
          detail: {
            diagnosticKind: "pi.localCancellationAfterAbortFailure",
            reason,
            timeoutMs: adapterTimeouts.interruptAbortWatchdogMs,
          },
        },
      } satisfies ProviderRuntimeEvent,
    ]);

  const handlePromptStartFailure = Effect.fn("handlePiPromptStartFailure")(function* (
    session: PiAdapterSessionContext,
    cause: PiSessionRuntimeError,
  ) {
    yield* completeTurn(session, undefined, "failed", {
      errorMessage: describeError(cause, "Pi prompt failed"),
    });
    if (cause instanceof PiRpcTimeoutError) {
      yield* cancelPendingUserInputs(session);
      session.nextTurnRequiresPromptStart = true;
      yield* discardRuntimeForRecovery(
        session,
        `Pi RPC prompt acknowledgement timed out after ${cause.input.timeoutMs}ms.`,
      );
    }
  });

  const recoverClosedRuntime = Effect.fn("recoverClosedPiRuntime")(function* (
    session: PiAdapterSessionContext,
    operation: string,
    cause: PiRpcLifecycleError,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    yield* discardRuntimeForRecovery(session, describeError(cause, "Pi RPC runtime closed"));
    yield* ensureRuntimeReady(session, operation);
  });

  const isProviderAdapterError = (cause: unknown): cause is ProviderAdapterError => {
    if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return false;
    return (
      cause._tag === "ProviderAdapterValidationError" ||
      cause._tag === "ProviderAdapterSessionNotFoundError" ||
      cause._tag === "ProviderAdapterSessionClosedError" ||
      cause._tag === "ProviderAdapterRequestError" ||
      cause._tag === "ProviderAdapterProcessError"
    );
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
    yield* clearNoEventWatchdog(session);
    yield* clearUsageRefreshTimer(session);
    session.usageRefreshQueue.length = 0;
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
        const runtimeRecoveryLock = yield* Semaphore.make(1);
        const session: PiAdapterSessionContext = {
          threadId: input.threadId,
          cwd: runtimeInput.cwd,
          scope: sessionScope,
          runtime,
          runtimeOptions: runtimeInput,
          runtimeRecoveryLock,
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
          completedTurnIds: new Set(),
          cancellingTurnIds: new Set(),
          promptAccepted: false,
          quarantinePromptEventsUntilAcceptedDrain: false,
          requirePromptStartBeforeCompletion: false,
          nextTurnRequiresPromptStart: false,
          completedPromptEventIds: new Set(),
          usageRefreshInFlight: false,
          usageRefreshQueue: [],
          turnActivitySequence: 0,
          noEventWarningEmitted: false,
          usageRefreshWaiters: new Set(),
          usageRefreshSequence: 0,
          latestForcedUsageRefreshSequence: 0,
          forcedUsageRefreshInFlight: 0,
          usageState: new PiUsageState(),
        };
        session.eventFiber = yield* forkRuntimeEvents(session, runtime);

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
        yield* restorePiWorkflowRuns(session, offer, workflowMonitorOptions());
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
    action: "interrupt" | "pause" | "resume" | "abort",
    target: string,
    reason: string,
    continuationMessage?: string,
  ) {
    const controlInput = {
      action,
      target,
      reason,
      ...(action === "resume" ? { policy: "continue-existing-session" as const } : {}),
      ...(continuationMessage ? { continuationMessage } : {}),
    };
    yield* ensureRuntimeReady(session, "workflow_control");
    const controlResult = yield* session.runtime.workflowControl(controlInput).pipe(Effect.result);
    if (Result.isFailure(controlResult)) {
      const cause = controlResult.failure;
      if (isClosedRuntimeLifecycleError(cause)) {
        yield* recoverClosedRuntime(session, "workflow_control", cause);
        yield* session.runtime
          .workflowControl(controlInput)
          .pipe(
            Effect.mapError((retryCause) =>
              mapPiRuntimeError(session.threadId, "workflow_control", retryCause),
            ),
          );
      } else {
        return yield* mapPiRuntimeError(session.threadId, "workflow_control", cause);
      }
    }
    const status =
      action === "resume"
        ? "recovering"
        : action === "pause"
          ? "paused"
          : action === "interrupt"
            ? "interrupted"
            : "aborting";
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
      yield* startPiWorkflowRunMonitor(session, offer, controlledRun, workflowMonitorOptions());
  });

  const beginTurn = Effect.fn("beginPiTurn")(function* (
    session: PiAdapterSessionContext,
    turnId: TurnId,
  ) {
    pruneRetainedPendingTools(session);
    session.currentTurnId = turnId;
    session.latestTurnId = turnId;
    session.turnCompleted = false;
    session.promptAccepted = true;
    session.quarantinePromptEventsUntilAcceptedDrain = session.nextTurnRequiresPromptStart;
    session.requirePromptStartBeforeCompletion = session.nextTurnRequiresPromptStart;
    session.nextTurnRequiresPromptStart = false;
    session.cancellingTurnIds.delete(turnId);
    delete session.activePromptEventId;
    yield* offer([
      { ...basePiEvent(session), type: "turn.started", payload: {} } satisfies ProviderRuntimeEvent,
      {
        ...basePiEvent(session),
        type: "session.state.changed",
        payload: { state: "running" },
      } satisfies ProviderRuntimeEvent,
    ]);
  });

  const finishPromptAcceptanceDrain = Effect.fn("finishPiPromptAcceptanceDrain")(function* (
    session: PiAdapterSessionContext,
  ) {
    if (!session.quarantinePromptEventsUntilAcceptedDrain) return;
    for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
    session.quarantinePromptEventsUntilAcceptedDrain = false;
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

  const activeWorkflowRuns = (session: PiAdapterSessionContext) =>
    Array.from(session.workflowRuns.values()).filter(
      (run) => !isTerminalWorkflowStatus(run.status),
    );

  const handleWorkflowContinuationPrompt = Effect.fn("handlePiWorkflowContinuationPrompt")(
    function* (
      session: PiAdapterSessionContext,
      input: ProviderSendTurnInput,
    ): Effect.fn.Return<ProviderTurnStartResult | undefined, ProviderAdapterError> {
      const message = input.input ?? "";
      if (!message.trim() || message.trimStart().startsWith("/")) return undefined;
      if (!isPlainWorkflowContinuationMessage(message)) return undefined;
      if ((input.attachments ?? []).length > 0) return undefined;
      const runs = activeWorkflowRuns(session);
      if (runs.length === 0) return undefined;

      const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
      yield* beginTurn(session, turnId);

      if (runs.length > 1) {
        yield* emitWorkflowControlNotice(
          session,
          `Multiple active workflow runs are associated with this session. Choose one explicitly with /workflow:resume <runId>.`,
          { activeWorkflowRuns: runs.map((run) => run.runId), ambiguous: true },
        );
        yield* completeTurn(session, undefined, "completed");
        return {
          threadId: input.threadId,
          turnId,
          ...(currentResumeCursor(session) ? { resumeCursor: currentResumeCursor(session) } : {}),
        };
      }

      const run = runs[0]!;
      session.workflowRunTurnIds.set(run.runId, turnId);
      yield* startPiWorkflowRunMonitor(session, offer, run, workflowMonitorOptions());
      yield* runWorkflowControl(
        session,
        "resume",
        run.runId,
        "User sent a workflow continuation from t3code.",
        message,
      ).pipe(
        Effect.tapError((cause) =>
          completeTurn(session, undefined, "failed", {
            errorMessage: describeError(cause, "Pi workflow continuation failed"),
          }),
        ),
      );
      yield* finishPromptAcceptanceDrain(session);
      yield* startNoEventWatchdog(session, turnId);
      yield* scheduleUsageRefresh(session, undefined, true);
      return {
        threadId: input.threadId,
        turnId,
        ...(currentResumeCursor(session) ? { resumeCursor: currentResumeCursor(session) } : {}),
      };
    },
  );

  const handlePiCompactCommand = Effect.fn("handlePiCompactCommand")(function* (
    session: PiAdapterSessionContext,
    input: ProviderSendTurnInput,
    command: PiCompactCommandInput,
  ): Effect.fn.Return<ProviderTurnStartResult, ProviderAdapterError> {
    if ((input.attachments ?? []).length > 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "compact",
        detail: "Pi /compact does not accept attachments.",
      });
    }

    yield* applyModelSelection(session, input.modelSelection, "compact");

    const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
    pruneRetainedPendingTools(session);
    session.currentTurnId = turnId;
    session.latestTurnId = turnId;
    session.turnCompleted = false;
    session.promptAccepted = false;
    session.quarantinePromptEventsUntilAcceptedDrain = false;
    session.requirePromptStartBeforeCompletion = false;
    session.nextTurnRequiresPromptStart = false;
    session.cancellingTurnIds.delete(turnId);
    delete session.activePromptEventId;

    yield* offer([
      { ...basePiEvent(session), type: "turn.started", payload: {} } satisfies ProviderRuntimeEvent,
      {
        ...basePiEvent(session),
        type: "session.state.changed",
        payload: { state: "running" },
      } satisfies ProviderRuntimeEvent,
    ]);

    const result = yield* session.runtime.compact(command.customInstructions).pipe(
      Effect.tapError((cause) =>
        completeTurn(session, undefined, "failed", { errorMessage: cause.message }).pipe(
          Effect.ignore,
        ),
      ),
      Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "compact", cause)),
    );

    yield* offer([
      {
        ...basePiEvent(session, { turnId }),
        type: "thread.state.changed",
        payload: { state: "compacted", detail: result },
      } satisfies ProviderRuntimeEvent,
    ]);
    yield* completeTurn(session, undefined, "completed");
    yield* scheduleUsageRefresh(session, { contextChange: "compaction" }, true);

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
    yield* ensureRuntimeReady(session, "turn/start");
    const compactCommand = parsePiCompactCommand(input.input);
    const controlResult = yield* handleWorkflowControlPrompt(session, input);
    if (controlResult) {
      yield* scheduleUsageRefresh(session, undefined, true);
      return controlResult;
    }

    if (!session.turnCompleted) {
      if (compactCommand) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "compact",
          detail: "Finish or stop the current Pi turn before compacting the session context.",
        });
      }
      const images = yield* resolveImageAttachments("turn/start", input);
      yield* session.runtime
        .steer({ message: input.input ?? "", images })
        .pipe(Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "steer", cause)));
      return {
        threadId: input.threadId,
        turnId: session.currentTurnId ?? TurnId.make(`pi-turn-${++turnCounter}`),
      };
    }

    if (compactCommand) {
      return yield* handlePiCompactCommand(session, input, compactCommand);
    }

    const continuationResult = yield* handleWorkflowContinuationPrompt(session, input);
    if (continuationResult) return continuationResult;

    const images = yield* resolveImageAttachments("turn/start", input);
    yield* applyModelSelection(session, input.modelSelection, "sendTurn");

    const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
    yield* beginTurn(session, turnId);
    yield* startPiWorkflowCommandMonitor(
      session,
      offer,
      input.input ?? "",
      workflowMonitorOptions(),
    );
    const startPrompt = () =>
      session.runtime.promptDetached({ message: input.input ?? "", images }).pipe(
        Effect.tap((promptResult) =>
          Effect.sync(() => {
            const cursor = parsePiResumeCursor(promptResult.resumeCursor);
            if (cursor?.sessionFile) session.sessionFile = cursor.sessionFile;
          }),
        ),
      );
    const promptResult = yield* startPrompt().pipe(
      Effect.result,
      Effect.ensuring(scheduleUsageRefresh(session, undefined, true)),
    );
    if (Result.isFailure(promptResult)) {
      const cause = promptResult.failure;
      if (isClosedBeforeDeliveryError(cause, "prompt")) {
        yield* recoverClosedRuntime(session, "turn/start", cause).pipe(
          Effect.tapError((recoveryCause) =>
            completeTurn(session, undefined, "failed", {
              errorMessage: describeError(recoveryCause, "Pi prompt failed"),
            }),
          ),
        );
        yield* startPrompt().pipe(
          Effect.tapError((retryCause) => handlePromptStartFailure(session, retryCause)),
          Effect.mapError((retryCause) => mapPiRuntimeError(input.threadId, "prompt", retryCause)),
          Effect.ensuring(scheduleUsageRefresh(session, undefined, true)),
        );
      } else {
        yield* handlePromptStartFailure(session, cause);
        return yield* mapPiRuntimeError(input.threadId, "prompt", cause);
      }
    }
    yield* finishPromptAcceptanceDrain(session);
    yield* startNoEventWatchdog(session, turnId);
    for (let index = 0; index < 5 && !session.turnCompleted; index += 1) {
      yield* Effect.yieldNow;
    }
    return {
      threadId: input.threadId,
      turnId,
      ...(currentResumeCursor(session) ? { resumeCursor: currentResumeCursor(session) } : {}),
    };
  });

  const sendActiveTurnInput = Effect.fn("sendPiActiveTurnInput")(function* (
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    const session = yield* requireSession(input.threadId);
    yield* ensureRuntimeReady(session, "turn/active-input");
    const images = yield* resolveImageAttachments("turn/start", input);
    yield* session.runtime
      .steer({ message: input.input ?? "", images })
      .pipe(Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "steer", cause)));
  });

  const interruptActiveWorkflows = (session: PiAdapterSessionContext) =>
    Effect.gen(function* () {
      const runs = activeWorkflowRuns(session);
      if (runs.length === 0) return false;
      let firstFailure: ProviderAdapterError | undefined;
      for (const run of runs) {
        const previous = session.workflowRuns.get(run.runId);
        session.workflowRuns.set(
          run.runId,
          mergeWorkflowRunCursor(previous, {
            runId: run.runId,
            lastSequence: previous?.lastSequence ?? run.lastSequence,
            ...(run.runDir ? { runDir: run.runDir } : {}),
            ...(run.auditPath ? { auditPath: run.auditPath } : {}),
            status: "interrupted",
          }),
        );
        yield* startPiWorkflowRunMonitor(session, offer, run, workflowMonitorOptions());
        const result = yield* runWorkflowControl(
          session,
          "interrupt",
          run.runId,
          "User interrupted active workflow work from t3code.",
        ).pipe(
          Effect.result,
          Effect.timeoutOption(Duration.millis(adapterTimeouts.interruptAbortWatchdogMs)),
        );
        if (Option.isNone(result)) {
          yield* discardRuntimeForRecovery(
            session,
            `Pi RPC workflow interrupt did not settle within ${adapterTimeouts.interruptAbortWatchdogMs}ms.`,
          );
          continue;
        }
        if (Result.isFailure(result.value)) {
          if (previous) session.workflowRuns.set(run.runId, previous);
          else {
            session.workflowRuns.delete(run.runId);
            session.workflowTails.delete(run.runId);
            session.workflowRunTurnIds.delete(run.runId);
          }
          firstFailure ??= result.value.failure;
          yield* emitWorkflowControlNotice(
            session,
            `Workflow ${run.runId} interrupt failed: ${describeError(result.value.failure, "Pi workflow interrupt failed")}`,
            { action: "interrupt", target: run.runId, status: previous?.status, failed: true },
          );
        }
      }
      if (firstFailure) return yield* firstFailure;
      yield* emitWorkflowControlNotice(
        session,
        "Workflow interrupt requested. Use /workflow:resume to continue or /workflow:abort to terminate it explicitly if artifacts show it is still recoverable.",
        { activeWorkflowRuns: runs.map((run) => run.runId) },
      );
      return true;
    });

  const interruptTurn = (threadId: ThreadId, requestedTurnId?: TurnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          yield* cancelPendingUserInputs(session);
          const interruptedTurnId = requestedTurnId ?? session.currentTurnId;
          const shouldCompleteInterruptedTurn =
            interruptedTurnId !== undefined &&
            !session.completedTurnIds.has(interruptedTurnId) &&
            !session.turnCompleted &&
            (requestedTurnId === undefined || requestedTurnId === session.currentTurnId);

          if (shouldCompleteInterruptedTurn) {
            session.cancellingTurnIds.add(interruptedTurnId);
            session.nextTurnRequiresPromptStart = true;
            yield* offer([
              {
                ...basePiEvent(session, { turnId: interruptedTurnId }),
                type: "turn.aborted",
                payload: { reason: "Interrupted by user" },
              } satisfies ProviderRuntimeEvent,
            ]);
            yield* completeTurn(session, undefined, "interrupted");
          }

          const workflowInterruptResult = yield* interruptActiveWorkflows(session).pipe(
            Effect.result,
          );
          const workflowInterruptFailure = Result.isFailure(workflowInterruptResult)
            ? workflowInterruptResult.failure
            : undefined;
          const interruptedWorkflow = Result.isSuccess(workflowInterruptResult)
            ? workflowInterruptResult.success
            : false;
          if (!shouldCompleteInterruptedTurn && workflowInterruptFailure)
            return yield* workflowInterruptFailure;
          if (!shouldCompleteInterruptedTurn && interruptedWorkflow) return;

          const abortResult = yield* session.runtime
            .abort()
            .pipe(
              Effect.exit,
              Effect.timeoutOption(Duration.millis(adapterTimeouts.interruptAbortWatchdogMs)),
            );
          if (Option.isNone(abortResult)) {
            const reason = `Pi RPC abort did not settle within ${adapterTimeouts.interruptAbortWatchdogMs}ms.`;
            yield* emitLocalInterruptAbortWarning(session, interruptedTurnId, reason);
            yield* discardRuntimeForRecovery(session, reason);
          } else if (Exit.isFailure(abortResult.value)) {
            const abortCause = Cause.squash(abortResult.value.cause);
            const reason = describeError(abortCause, "Pi RPC abort failed");
            yield* emitLocalInterruptAbortWarning(session, interruptedTurnId, reason);
            if (isClosedRuntimeLifecycleError(abortCause)) {
              yield* discardRuntimeForRecovery(session, reason);
            }
          }
          if (workflowInterruptFailure) return yield* workflowInterruptFailure;
        }),
      ),
      Effect.mapError((cause): ProviderAdapterError => cause),
    );

  const readThread = (threadId: ThreadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        ensureRuntimeReady(session, "get_messages").pipe(Effect.as(session)),
      ),
      Effect.flatMap((session) =>
        session.runtime.getMessages.pipe(
          Effect.catchIf(isClosedRuntimeLifecycleError, (cause) =>
            recoverClosedRuntime(session, "get_messages", cause).pipe(
              Effect.flatMap(() => session.runtime.getMessages),
            ),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        isProviderAdapterError(cause) ? cause : mapPiRuntimeError(threadId, "get_messages", cause),
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
