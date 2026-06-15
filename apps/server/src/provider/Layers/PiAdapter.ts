// @effect-diagnostics preferSchemaOverJson:off
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { basePiEvent, PiEventMapper } from "./PiEventMapper.ts";
import type { PiAdapterSessionContext } from "./PiAdapterTypes.ts";
import {
  DEFAULT_PI_RPC_TIMEOUTS,
  PiResumeCursorSchema,
  PiRpcLifecycleError,
  PiRpcSpawnError,
  makePiSessionRuntime,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "./PiSessionRuntime.ts";
import { normalizePiReadThread } from "./PiReadThread.ts";
import { normalizePiTokenUsage } from "./PiUsage.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const DEFAULT_USAGE_DEBOUNCE_MS = 50;
const isPiResumeCursor = Schema.is(PiResumeCursorSchema);

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: PiSessionRuntimeOptions,
  ) => Effect.Effect<PiSessionRuntimeShape, PiSessionRuntimeError, Scope.Scope>;
  readonly usageDebounceMs?: number;
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
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiAdapterSessionContext>();
  let turnCounter = 0;

  const offer = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const completeTurn = (
    session: PiAdapterSessionContext,
    raw?: PiRpcRuntimeMessage,
    state: "completed" | "failed" | "cancelled" | "interrupted" = "completed",
  ) =>
    Effect.gen(function* () {
      if (session.turnCompleted) return;
      session.turnCompleted = true;
      yield* offer([
        {
          ...basePiEvent(session, raw ? { raw } : undefined),
          type: "turn.completed",
          payload: { state },
        } satisfies ProviderRuntimeEvent,
        {
          ...basePiEvent(session, raw ? { raw } : undefined),
          type: "session.state.changed",
          payload: { state: state === "failed" ? "error" : "ready" },
        } satisfies ProviderRuntimeEvent,
      ]);
    });

  const refreshUsage = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const statsResult = yield* session.runtime.getSessionStats.pipe(Effect.result);
      if (Result.isFailure(statsResult)) return;
      const usage = normalizePiTokenUsage(statsResult.success);
      if (!usage) return;
      const key = JSON.stringify(usage);
      if (key === session.lastUsageKey) return;
      session.lastUsageKey = key;
      yield* offer([
        {
          ...basePiEvent(session),
          type: "thread.token-usage.updated",
          payload: { usage },
        } satisfies ProviderRuntimeEvent,
      ]);
    });

  const scheduleUsageRefresh = (session: PiAdapterSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (session.usageRefreshFiber) {
        session.usageRefreshQueued = true;
        return;
      }
      const debounceMs = options?.usageDebounceMs ?? DEFAULT_USAGE_DEBOUNCE_MS;
      if (debounceMs <= 0) {
        yield* refreshUsage(session);
        return;
      }
      session.usageRefreshFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(debounceMs));
        yield* refreshUsage(session);
        delete session.usageRefreshFiber;
        if (session.usageRefreshQueued && !session.stopped) {
          session.usageRefreshQueued = false;
          yield* scheduleUsageRefresh(session);
        }
      }).pipe(Effect.forkChild);
    });

  const mapper = new PiEventMapper(offer, scheduleUsageRefresh, completeTurn);

  const requireSession = Effect.fn("requirePiSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped)
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return session;
  });

  const stopSessionInternal = Effect.fn("stopPiSessionInternal")(function* (
    session: PiAdapterSessionContext,
  ) {
    if (session.stopped) return;
    session.stopped = true;
    sessions.delete(session.threadId);
    if (session.usageRefreshFiber)
      yield* Fiber.interrupt(session.usageRefreshFiber).pipe(Effect.ignore);
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

        const runtimeInput: PiSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          binaryPath: piConfig.binaryPath,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(isPiResumeCursor(input.resumeCursor) ? { resumeCursor: input.resumeCursor } : {}),
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
        const session: PiAdapterSessionContext = {
          threadId: input.threadId,
          cwd: runtimeInput.cwd,
          scope: sessionScope,
          runtime,
          tools: new Map(),
          stopped: false,
          turnCompleted: true,
          usageRefreshQueued: false,
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
        sessions.set(input.threadId, session);
        sessionScopeTransferred = true;
        yield* offer([
          {
            ...basePiEvent(session),
            type: "session.started",
            payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
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
        return started;
      }),
    );

  const sendTurn = Effect.fn("sendPiTurn")(function* (
    input: ProviderSendTurnInput,
  ): Effect.fn.Return<ProviderTurnStartResult, ProviderAdapterError> {
    const session = yield* requireSession(input.threadId);
    const turnId = TurnId.make(`pi-turn-${++turnCounter}`);
    session.currentTurnId = turnId;
    session.turnCompleted = false;
    yield* offer([
      { ...basePiEvent(session), type: "turn.started", payload: {} } satisfies ProviderRuntimeEvent,
      {
        ...basePiEvent(session),
        type: "session.state.changed",
        payload: { state: "running" },
      } satisfies ProviderRuntimeEvent,
    ]);
    const result = yield* session.runtime
      .prompt({ message: input.input ?? "", images: [] })
      .pipe(Effect.mapError((cause) => mapPiRuntimeError(input.threadId, "prompt", cause)));
    if (!session.turnCompleted) yield* completeTurn(session);
    yield* scheduleUsageRefresh(session);
    return {
      threadId: result.threadId,
      turnId,
      ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
    };
  });

  const sendActiveTurnInput = (input: ProviderSendTurnInput) =>
    requireSession(input.threadId).pipe(
      Effect.flatMap((session) =>
        session.runtime.steer({ message: input.input ?? "", images: [] }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapPiRuntimeError(input.threadId, "steer", cause),
      ),
    );

  const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.runtime.abort().pipe(
          Effect.tap(() =>
            offer([
              {
                ...basePiEvent(session),
                type: "turn.aborted",
                payload: { reason: "Interrupted by user" },
              } satisfies ProviderRuntimeEvent,
              {
                ...basePiEvent(session),
                type: "turn.completed",
                payload: { state: "interrupted" },
              } satisfies ProviderRuntimeEvent,
            ]),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapPiRuntimeError(threadId, "abort", cause),
      ),
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
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    sendActiveTurnInput,
    interruptTurn,
    respondToRequest: () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Native Pi does not expose approval request responses in Phase 3.",
        }),
      ),
    respondToUserInput: () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Native Pi extension UI responses are implemented in Phase 4.",
        }),
      ),
    stopSession,
    listSessions: () =>
      Effect.forEach(
        Array.from(sessions.values()).filter((session) => !session.stopped),
        (session) => session.runtime.getSession,
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
