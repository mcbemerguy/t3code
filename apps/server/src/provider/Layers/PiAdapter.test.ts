import assert from "node:assert/strict";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../Errors.ts";
import { makePiAdapter, type PiAdapterShape } from "./PiAdapter.ts";
import {
  PiRpcLifecycleError,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "./PiSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const threadId = ThreadId.make("thread-pi-adapter");

class FakePiRuntime implements PiSessionRuntimeShape {
  private readonly eventQueue: Queue.Queue<PiRpcRuntimeMessage>;
  readonly events: Stream.Stream<PiRpcRuntimeMessage>;
  readonly now = "2026-01-01T00:00:00.000Z";
  stats: unknown = {
    tokens: { input: 10, output: 2 },
    contextUsage: { usedTokens: 12, maxTokens: 100 },
  };
  messages: unknown = [{ id: "message-turn-1", role: "assistant", content: "hello" }];
  promptScript: ((runtime: FakePiRuntime) => Effect.Effect<void>) | undefined;

  startImpl = vi.fn(() => Promise.resolve(this.session("ready")));
  promptImpl = vi.fn(
    async () =>
      ({
        threadId: this.options.threadId,
        turnId: TurnId.make("pi-provider-turn"),
      }) satisfies ProviderTurnStartResult,
  );
  steerImpl = vi.fn(
    (_input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) =>
      Promise.resolve(undefined),
  );
  abortImpl = vi.fn(() => Promise.resolve(undefined));
  closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: PiSessionRuntimeOptions;

  constructor(options: PiSessionRuntimeOptions, eventQueue: Queue.Queue<PiRpcRuntimeMessage>) {
    this.options = options;
    this.eventQueue = eventQueue;
    this.events = Stream.fromQueue(eventQueue);
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.sync(() => this.session("ready"));

  prompt(_input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) {
    const script = this.promptScript;
    const runPrompt = this.promptImpl;
    return (script ? script(this) : Effect.void).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => runPrompt(),
          catch: (error) =>
            error instanceof PiRpcLifecycleError
              ? error
              : new PiRpcLifecycleError(
                  error instanceof Error ? error.message : "prompt failed",
                  error,
                ),
        }),
      ),
    );
  }

  steer(input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) {
    return Effect.promise(() => this.steerImpl(input));
  }

  abort() {
    return Effect.promise(() => this.abortImpl());
  }

  getState = Effect.succeed({ sessionFile: "/tmp/pi-session.json" });
  getAvailableModels = Effect.succeed({ providers: [] });
  setModel = (_provider: string, _modelId: string) => Effect.succeed({});
  getSessionStats = Effect.sync(() => this.stats);
  getMessages = Effect.sync(() => this.messages);
  workflowControl = () => Effect.succeed({});
  respondExtensionUi = () => Effect.void;
  consumePreludeLines = Effect.succeed([]);
  close = Effect.promise(() => this.closeImpl());

  emit(payload: Record<string, unknown>) {
    return Queue.offer(this.eventQueue, { kind: "event", payload });
  }

  private session(status: ProviderSession["status"]): ProviderSession {
    return {
      provider: PROVIDER,
      providerInstanceId: ProviderInstanceId.make("pi"),
      status,
      runtimeMode: this.options.runtimeMode,
      cwd: this.options.cwd,
      threadId: this.options.threadId,
      resumeCursor: { sessionFile: "/tmp/pi-session.json" },
      createdAt: this.now,
      updatedAt: this.now,
    };
  }
}

function withHarness<T>(
  configure: ((runtime: FakePiRuntime) => void) | undefined,
  use: (harness: {
    adapter: PiAdapterShape;
    runtime: FakePiRuntime;
  }) => Effect.Effect<T, ProviderAdapterError>,
) {
  const runtimes: Array<FakePiRuntime> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "pi" },
        {
          usageDebounceMs: 0,
          makeRuntime: (options) =>
            Effect.gen(function* () {
              const eventQueue = yield* Queue.unbounded<PiRpcRuntimeMessage>();
              const runtime = new FakePiRuntime(options, eventQueue);
              configure?.(runtime);
              runtimes.push(runtime);
              return runtime;
            }),
        },
      );
      yield* adapter.startSession({
        provider: PROVIDER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      return yield* use({ adapter, runtime: runtimes[0] as FakePiRuntime });
    }),
  );
}

function collectEvents(
  adapter: PiAdapterShape,
  count: number,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<Array<ProviderRuntimeEvent>> {
  return Stream.runCollect(
    adapter.streamEvents.pipe(Stream.filter(predicate), Stream.take(count)),
  ).pipe(Effect.map((events) => Array.from(events) as Array<ProviderRuntimeEvent>));
}

describe("PiAdapter", () => {
  it.effect("maps chat streaming and prompt lifecycle events", () =>
    withHarness(
      (fake) => {
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "hel" },
            });
            yield* rt.emit({ type: "assistant_delta", text: "lo" });
            yield* rt.emit({ type: "agent_end" });
          });
      },
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(
            adapter,
            3,
            (event) => event.type === "content.delta" || event.type === "turn.completed",
          ).pipe(Effect.forkChild);
          const result = yield* adapter.sendTurn({ threadId, input: "hi" });
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(result.turnId, "pi-turn-1");
          assert.deepEqual(
            events
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta)
              .slice(0, 2),
            ["hel", "lo"],
          );
          assert.equal(runtime.promptImpl.mock.calls.length, 1);
        }),
    ),
  );

  it.effect("maps thought streaming and usage refresh", () =>
    withHarness(
      (fake) => {
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_start" },
            });
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
            });
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_end" },
            });
          });
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(
            adapter,
            2,
            (event) =>
              event.type === "content.delta" || event.type === "thread.token-usage.updated",
          ).pipe(Effect.forkChild);
          yield* adapter.sendTurn({ threadId, input: "think" });
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(
            events.some(
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
            ),
            true,
          );
          assert.equal(
            events.some((event) => event.type === "thread.token-usage.updated"),
            true,
          );
        }),
    ),
  );

  it.effect("maps Pi tool lifecycle and edit diffs to canonical events", () =>
    withHarness(
      (fake) => {
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "tool_execution_start",
              toolCallId: "tool-1",
              toolName: "bash",
              args: { command: "echo ok" },
            });
            yield* rt.emit({
              type: "tool_execution_update",
              toolCallId: "tool-1",
              partialResult: { stdout: "ok" },
            });
            yield* rt.emit({
              type: "tool_execution_end",
              toolCallId: "tool-1",
              result: { stdout: "done" },
            });
          });
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(
            adapter,
            4,
            (event) =>
              event.type === "item.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed",
          ).pipe(Effect.forkChild);
          yield* adapter.sendTurn({ threadId, input: "run" });
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(events[0]?.type, "item.started");
          if (events[0]?.type === "item.started")
            assert.equal(events[0].payload.itemType, "command_execution");
          assert.equal(events[1]?.type, "content.delta");
          assert.equal(events.at(-1)?.type, "item.completed");
        }),
    ),
  );

  it.effect("does not complete a turn until Pi emits a terminal event", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const eventsFiber = yield* collectEvents(
          adapter,
          2,
          (event) => event.type === "content.delta" || event.type === "turn.completed",
        ).pipe(Effect.forkChild);

        yield* adapter.sendTurn({ threadId, input: "hi" });
        yield* runtime.emit({ type: "assistant_delta", text: "hello" });
        yield* runtime.emit({ type: "agent_end" });
        const events = yield* Fiber.join(eventsFiber);

        assert.deepEqual(
          events.map((event) => event.type),
          ["content.delta", "turn.completed"],
        );
      }),
    ),
  );

  it.effect("routes sendTurn to Pi steer while a turn is active", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const first = yield* adapter.sendTurn({ threadId, input: "start" });
        const second = yield* adapter.sendTurn({ threadId, input: "while active" });

        assert.equal(first.turnId, "pi-turn-1");
        assert.equal(second.turnId, "pi-turn-1");
        assert.equal(runtime.promptImpl.mock.calls.length, 1);
        assert.equal(runtime.steerImpl.mock.calls[0]?.[0].message, "while active");
      }),
    ),
  );

  it.effect("completes the active turn as failed when prompt acceptance fails", () =>
    withHarness(
      (fake) => {
        fake.promptImpl.mockRejectedValueOnce(new Error("prompt failed"));
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(
            adapter,
            2,
            (event) =>
              event.type === "turn.completed" ||
              (event.type === "session.state.changed" && event.payload.state === "error"),
          ).pipe(Effect.forkChild);
          const result = yield* adapter.sendTurn({ threadId, input: "fail" }).pipe(Effect.result);
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(result._tag, "Failure");
          assert.equal(
            events.some(
              (event) => event.type === "turn.completed" && event.payload.state === "failed",
            ),
            true,
          );
          assert.equal(
            events.some(
              (event) => event.type === "session.state.changed" && event.payload.state === "error",
            ),
            true,
          );
        }),
    ),
  );

  it.effect("supports active-turn steering, interrupt, session close, and readThread", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        yield* adapter.sendActiveTurnInput({ threadId, input: "steer" });
        yield* adapter.interruptTurn(threadId);
        const snapshot = yield* adapter.readThread(threadId);
        yield* adapter.stopSession(threadId);

        assert.equal(runtime.steerImpl.mock.calls[0]?.[0].message, "steer");
        assert.equal(runtime.abortImpl.mock.calls.length, 1);
        assert.equal(runtime.closeImpl.mock.calls.length, 1);
        assert.equal(snapshot.turns[0]?.id, "message-turn-1");
        assert.equal(yield* adapter.hasSession(threadId), false);
      }),
    ),
  );

  it.effect("rejects rollback explicitly as unsupported", () =>
    withHarness(undefined, ({ adapter }) =>
      Effect.gen(function* () {
        const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.match(result.failure.message, /unsupported/i);
      }),
    ),
  );
});
