// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
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
  type PiExtensionUiResponseInput,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
  type PiWorkflowControlInput,
} from "./PiSessionRuntime.ts";
import { makePiResumeCursor } from "./PiWorkflowCursor.ts";

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
  extensionUiResponses: Array<PiExtensionUiResponseInput> = [];
  workflowControls: Array<PiWorkflowControlInput> = [];
  modelSelections: Array<{ provider: string; modelId: string }> = [];
  currentModel: string | undefined;

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
    this.currentModel = options.model;
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
  setModel = (provider: string, modelId: string) =>
    Effect.sync(() => {
      this.modelSelections.push({ provider, modelId });
      this.currentModel = `${provider}/${modelId}`;
      return {};
    });
  getSessionStats = Effect.sync(() => this.stats);
  getMessages = Effect.sync(() => this.messages);
  workflowControl = (input: PiWorkflowControlInput) =>
    Effect.sync(() => {
      this.workflowControls.push(input);
      return {};
    });
  respondExtensionUi = (input: PiExtensionUiResponseInput) =>
    Effect.sync(() => {
      this.extensionUiResponses.push(input);
    });
  consumePreludeLines = Effect.succeed([]);
  close = Effect.promise(() => this.closeImpl());

  emit(payload: Record<string, unknown>) {
    return Queue.offer(this.eventQueue, { kind: "event", payload });
  }

  private session(status: ProviderSession["status"]): ProviderSession {
    return {
      provider: PROVIDER,
      providerInstanceId: this.options.providerInstanceId ?? ProviderInstanceId.make("pi"),
      status,
      runtimeMode: this.options.runtimeMode,
      cwd: this.options.cwd,
      threadId: this.options.threadId,
      ...(this.currentModel ? { model: this.currentModel } : {}),
      resumeCursor: this.options.resumeCursor ?? { sessionFile: "/tmp/pi-session.json" },
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
  startInput?: Partial<ProviderSessionStartInput>,
  adapterOptions?: { readonly instanceId?: ProviderInstanceId },
) {
  const runtimes: Array<FakePiRuntime> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "pi" },
        {
          usageDebounceMs: 0,
          ...(adapterOptions?.instanceId ? { instanceId: adapterOptions.instanceId } : {}),
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
        ...startInput,
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

function createWorkflowRunFixture(input: {
  readonly runId?: string;
  readonly status?: string;
  readonly events?: ReadonlyArray<Record<string, unknown>>;
}) {
  const root = mkdtempSync(join(tmpdir(), "t3-pi-workflow-"));
  const runId = input.runId ?? "run-1";
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  const auditPath = join(runDir, "audit.md");
  writeFileSync(auditPath, "# audit\n", "utf8");
  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({
      id: runId,
      workflowId: "review-fix",
      commandName: "workflow:review-fix",
      cwd: process.cwd(),
      runDir,
      auditPath,
      status: input.status ?? "running",
      endedAt: input.status === "completed" ? "2026-01-01T00:00:00.000Z" : undefined,
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(runDir, "events.jsonl"),
    (input.events ?? [])
      .map((event) =>
        JSON.stringify({ runId, workflowId: "review-fix", runDir, auditPath, ...event }),
      )
      .join("\n") + "\n",
    "utf8",
  );
  return { root, runId, runDir, auditPath };
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

  it.effect("maps Pi edit tool file changes to structured diffs", () => {
    const root = mkdtempSync(join(tmpdir(), "t3-pi-edit-"));
    writeFileSync(join(root, "note.txt"), "old\n", "utf8");

    return withHarness(
      (fake) => {
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "tool_execution_start",
              toolCallId: "edit-1",
              toolName: "edit",
              args: { path: "note.txt" },
            });
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            writeFileSync(join(root, "note.txt"), "new\n", "utf8");
            yield* rt.emit({
              type: "tool_execution_end",
              toolCallId: "edit-1",
              result: { content: [{ type: "text", text: "edited" }] },
            });
          });
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(
            adapter,
            3,
            (event) =>
              event.type === "item.started" ||
              event.type === "turn.diff.updated" ||
              event.type === "item.completed",
          ).pipe(Effect.forkChild);
          yield* adapter.sendTurn({ threadId, input: "edit" });
          const events = yield* Fiber.join(eventsFiber);

          const diff = events.find((event) => event.type === "turn.diff.updated");
          assert.equal(diff?.type, "turn.diff.updated");
          if (diff?.type === "turn.diff.updated") {
            assert.match(diff.payload.unifiedDiff, /--- a\/note\.txt/);
            assert.match(diff.payload.unifiedDiff, /\+new/);
            assert.match(diff.payload.unifiedDiff, /-old/);
          }
        }),
      { cwd: root },
    );
  });

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

  it.effect("applies selected Pi models through set_model", () =>
    withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          assert.deepEqual(runtime.modelSelections, [{ provider: "mock", modelId: "model-a" }]);

          yield* adapter.sendTurn({
            threadId,
            input: "switch",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "mock/model-b",
            },
          });

          assert.deepEqual(runtime.modelSelections, [
            { provider: "mock", modelId: "model-a" },
            { provider: "mock", modelId: "model-b" },
          ]);
          assert.equal((yield* runtime.getSession).model, "mock/model-b");
        }),
      {
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "mock/model-a",
        },
      },
    ),
  );

  it.effect("rejects Pi model selections that cannot be sent to set_model", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "bad model",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "model-without-provider",
            },
          })
          .pipe(Effect.flip, Effect.orDie);

        assert.match(error.message, /<provider>\/<modelId>/);
        assert.equal(runtime.promptImpl.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("includes Pi provider instance identity in resume cursors", () =>
    withHarness(
      undefined,
      ({ adapter }) =>
        Effect.gen(function* () {
          const sessions = yield* adapter.listSessions();

          assert.equal(sessions[0]?.providerInstanceId, "pi_work");
          assert.deepEqual(sessions[0]?.resumeCursor, {
            schemaVersion: 1,
            provider: "pi",
            providerInstanceId: "pi_work",
            sessionFile: "/tmp/pi-session.json",
          });
        }),
      undefined,
      { instanceId: ProviderInstanceId.make("pi_work") },
    ),
  );

  it.effect("does not restore a Pi session cursor from a different provider instance", () =>
    withHarness(
      undefined,
      ({ runtime }) =>
        Effect.sync(() => {
          assert.equal(runtime.options.resumeCursor, undefined);
        }),
      {
        resumeCursor: {
          schemaVersion: 1,
          provider: "pi",
          providerInstanceId: "pi_personal",
          sessionFile: "/tmp/personal-pi-session.json",
        },
      },
      { instanceId: ProviderInstanceId.make("pi_work") },
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

  it.effect("maps select/input/editor/confirm extension UI requests and normalizes responses", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const eventsFiber = yield* collectEvents(
          adapter,
          4,
          (event) => event.type === "user-input.requested",
        ).pipe(Effect.forkChild);

        yield* runtime.emit({
          type: "extension_ui_request",
          id: "select-1",
          method: "select",
          title: "Choose",
          message: "Pick one",
          options: ["Red", "Blue", "Other (type your own answer)"],
        });
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "input-1",
          method: "input",
          title: "Name",
          message: "Enter a name",
          placeholder: "Ada",
        });
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "editor-1",
          method: "editor",
          title: "Edit",
          message: "Edit the text",
          prefill: "draft",
        });
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Confirm",
          message: "Continue?",
        });

        const events = yield* Fiber.join(eventsFiber);
        const requestIds = events.map((event) => ApprovalRequestId.make(event.requestId ?? ""));

        assert.deepEqual(
          events.map((event) =>
            event.type === "user-input.requested" ? event.payload.questions[0]?.id : undefined,
          ),
          ["selection", "value", "value", "confirmed"],
        );
        const selectQuestion = events[0];
        assert.equal(selectQuestion?.type, "user-input.requested");
        if (selectQuestion?.type === "user-input.requested") {
          assert.deepEqual(
            selectQuestion.payload.questions[0]?.options.map((option) => option.label),
            ["Red", "Blue"],
          );
        }

        yield* adapter.respondToUserInput(threadId, requestIds[0]!, { selection: "1" });
        yield* adapter.respondToUserInput(threadId, requestIds[1]!, { value: "Grace" });
        yield* adapter.respondToUserInput(threadId, requestIds[2]!, { value: { label: "edited" } });
        yield* adapter.respondToUserInput(threadId, requestIds[3]!, { confirmed: "yes" });

        assert.deepEqual(runtime.extensionUiResponses, [
          { id: "select-1", value: "Blue" },
          { id: "input-1", value: "Grace" },
          { id: "editor-1", value: "edited" },
          { id: "confirm-1", confirmed: true },
        ]);
      }),
    ),
  );

  it.effect("cancels pending extension UI requests on interrupt while blocked on user input", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        runtime.promptScript = (rt) =>
          rt.emit({
            type: "extension_ui_request",
            id: "blocked-input",
            method: "input",
            title: "Need input",
            message: "Provide value",
          });
        const requestedFiber = yield* collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.requested",
        ).pipe(Effect.forkChild);
        yield* adapter.sendTurn({ threadId, input: "ask" });
        const [requested] = yield* Fiber.join(requestedFiber);
        assert.equal(requested?.type, "user-input.requested");

        const resolvedFiber = yield* collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.resolved",
        ).pipe(Effect.forkChild);
        yield* adapter.interruptTurn(threadId);
        const [resolved] = yield* Fiber.join(resolvedFiber);

        assert.deepEqual(runtime.extensionUiResponses.at(-1), {
          id: "blocked-input",
          cancelled: true,
        });
        assert.equal(runtime.abortImpl.mock.calls.length, 1);
        assert.equal(resolved?.type, "user-input.resolved");
        if (resolved?.type === "user-input.resolved")
          assert.deepEqual(resolved.payload.answers, { id: "blocked-input", cancelled: true });
      }),
    ),
  );

  it.effect("cancels pending extension UI requests on session close", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const requestedFiber = yield* collectEvents(
          adapter,
          1,
          (event) => event.type === "user-input.requested",
        ).pipe(Effect.forkChild);
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "close-input",
          method: "input",
          title: "Need input",
          message: "Provide value",
        });
        yield* Fiber.join(requestedFiber);

        yield* adapter.stopSession(threadId);

        assert.deepEqual(runtime.extensionUiResponses.at(-1), {
          id: "close-input",
          cancelled: true,
        });
        assert.equal(runtime.closeImpl.mock.calls.length, 1);
        assert.equal(yield* adapter.hasSession(threadId), false);
      }),
    ),
  );

  it.effect("rejects unknown pending extension UI responses", () =>
    withHarness(undefined, ({ adapter }) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .respondToUserInput(threadId, ApprovalRequestId.make("missing"), { value: "late" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.match(result.failure.message, /Unknown Pi extension UI/);
      }),
    ),
  );

  it.effect("cancels unknown blocking extension UI requests instead of leaving Pi blocked", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const eventsFiber = yield* collectEvents(
          adapter,
          1,
          (event) => event.type === "runtime.warning",
        ).pipe(Effect.forkChild);
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "future-dialog-1",
          method: "futureDialog",
          message: "Unsupported dialog",
        });
        const [event] = yield* Fiber.join(eventsFiber);

        assert.deepEqual(runtime.extensionUiResponses, [
          { id: "future-dialog-1", cancelled: true },
        ]);
        assert.equal(event?.type, "runtime.warning");
        if (event?.type === "runtime.warning")
          assert.equal(event.payload.message, "Pi extension UI event: futureDialog");
      }),
    ),
  );

  it.effect("emits fire-and-forget extension UI events as non-blocking notices", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const eventsFiber = yield* collectEvents(
          adapter,
          1,
          (event) => event.type === "runtime.warning",
        ).pipe(Effect.forkChild);
        yield* runtime.emit({
          type: "extension_ui_request",
          id: "notify-1",
          method: "notify",
          message: "Heads up",
        });
        const [event] = yield* Fiber.join(eventsFiber);

        assert.equal(event?.type, "runtime.warning");
        if (event?.type === "runtime.warning") assert.equal(event.payload.message, "Heads up");
        assert.deepEqual(runtime.extensionUiResponses, []);
      }),
    ),
  );

  it.effect("parses and serializes native Pi workflow resume cursors", () =>
    Effect.sync(() => {
      const cursor = makePiResumeCursor({
        sessionFile: "/tmp/pi-session.json",
        activeWorkflowRuns: [
          { runId: "active", lastSequence: 4, runDir: "/tmp/run", status: "running" },
          { runId: "done", lastSequence: 9, status: "completed" },
        ],
      });
      assert.deepEqual(cursor, {
        schemaVersion: 1,
        provider: "pi",
        sessionFile: "/tmp/pi-session.json",
        workflows: {
          activeRuns: [{ runId: "active", lastSequence: 4, runDir: "/tmp/run", status: "running" }],
        },
      });
    }),
  );

  it.effect(
    "replays workflow events on restore, dedupes by sequence, updates usage, and clears terminal runs",
    () => {
      const fixture = createWorkflowRunFixture({
        status: "completed",
        events: [
          { type: "run_start", sequence: 1 },
          { type: "run_start", sequence: 1 },
          { type: "step_start", sequence: 2, stepId: "code", stepType: "agent" },
          {
            type: "context_usage_update",
            sequence: 3,
            usage: {
              context: { usedTokens: 42, maxTokens: 100 },
              totals: { inputTokens: 20, outputTokens: 5 },
            },
          },
          { type: "run_end", sequence: 4, status: "completed" },
        ],
      });
      return withHarness(
        undefined,
        ({ adapter }) =>
          Effect.gen(function* () {
            const events = yield* collectEvents(
              adapter,
              4,
              (event) =>
                event.raw?.source === "pi.workflow.artifact" &&
                (event.type === "item.started" ||
                  event.type === "turn.plan.updated" ||
                  event.type === "thread.token-usage.updated" ||
                  event.type === "task.completed"),
            );
            const sessions = yield* adapter.listSessions();

            assert.equal(events.filter((event) => event.type === "item.started").length, 1);
            assert.equal(
              events.some((event) => event.type === "turn.plan.updated"),
              true,
            );
            assert.equal(
              events.some(
                (event) =>
                  event.type === "thread.token-usage.updated" &&
                  event.payload.usage.usedTokens === 42,
              ),
              true,
            );
            assert.equal(
              events.some((event) => event.type === "task.completed"),
              true,
            );
            assert.deepEqual(sessions[0]?.resumeCursor, {
              schemaVersion: 1,
              provider: "pi",
              providerInstanceId: "pi",
              sessionFile: "/tmp/pi-session.json",
            });
          }),
        {
          resumeCursor: makePiResumeCursor({
            sessionFile: "/tmp/pi-session.json",
            activeWorkflowRuns: [
              { runId: fixture.runId, lastSequence: 0, runDir: fixture.runDir, status: "running" },
            ],
          }),
        },
      );
    },
  );

  it.effect(
    "does not duplicate workflow child assistant text when final message follows text_end",
    () => {
      const fixture = createWorkflowRunFixture({
        status: "completed",
        events: [
          { type: "run_start", sequence: 1 },
          {
            type: "child_pi_event",
            sequence: 2,
            stepId: "code",
            childSessionId: "child-1",
            childEventType: "message_update",
            event: { assistantMessageEvent: { type: "text_delta", delta: "hel" } },
          },
          {
            type: "child_pi_event",
            sequence: 3,
            stepId: "code",
            childSessionId: "child-1",
            childEventType: "message_update",
            event: { assistantMessageEvent: { type: "text_end", content: "hello" } },
          },
          {
            type: "child_pi_event",
            sequence: 4,
            stepId: "code",
            childSessionId: "child-1",
            childEventType: "message_end",
            event: { message: { role: "assistant", content: "hello" } },
          },
          { type: "run_end", sequence: 5, status: "completed" },
        ],
      });
      return withHarness(
        undefined,
        ({ adapter }) =>
          Effect.gen(function* () {
            const events = yield* collectEvents(
              adapter,
              6,
              (event) => event.raw?.source === "pi.workflow.artifact",
            );
            const helloDeltas = events.filter(
              (event) =>
                event.type === "content.delta" &&
                event.payload.streamKind === "assistant_text" &&
                event.payload.delta === "hello",
            );

            assert.equal(helloDeltas.length, 1);
          }),
        {
          resumeCursor: makePiResumeCursor({
            sessionFile: "/tmp/pi-session.json",
            activeWorkflowRuns: [
              { runId: fixture.runId, lastSequence: 0, runDir: fixture.runDir, status: "running" },
            ],
          }),
        },
      );
    },
  );

  it.effect(
    "attaches restored active workflow runs and pauses them before aborting Pi turns",
    () => {
      const fixture = createWorkflowRunFixture({
        status: "running",
        events: [{ type: "run_start", sequence: 1 }],
      });
      return withHarness(
        undefined,
        ({ adapter, runtime }) =>
          Effect.gen(function* () {
            yield* adapter.interruptTurn(threadId);
            const sessions = yield* adapter.listSessions();

            assert.equal(runtime.abortImpl.mock.calls.length, 0);
            assert.deepEqual(runtime.workflowControls[0], {
              action: "pause",
              target: fixture.runId,
              reason: "User requested workflow interruption from t3code.",
            });
            assert.deepEqual(sessions[0]?.resumeCursor, {
              schemaVersion: 1,
              provider: "pi",
              providerInstanceId: "pi",
              sessionFile: "/tmp/pi-session.json",
              workflows: {
                activeRuns: [
                  {
                    runId: fixture.runId,
                    lastSequence: 1,
                    runDir: fixture.runDir,
                    auditPath: fixture.auditPath,
                    status: "paused",
                  },
                ],
              },
            });
          }),
        {
          resumeCursor: makePiResumeCursor({
            sessionFile: "/tmp/pi-session.json",
            activeWorkflowRuns: [
              { runId: fixture.runId, lastSequence: 0, runDir: fixture.runDir, status: "running" },
            ],
          }),
        },
      );
    },
  );

  it.effect("maps workflow resume and abort prompts to Pi workflow_control", () => {
    const fixture = createWorkflowRunFixture({
      status: "paused",
      events: [{ type: "run_paused", sequence: 1, status: "paused" }],
    });
    return withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId, input: `/workflow:resume ${fixture.runId}` });
          yield* adapter.sendTurn({ threadId, input: `/workflow:abort ${fixture.runId}` });
          const sessions = yield* adapter.listSessions();

          assert.equal(runtime.workflowControls[0]?.action, "resume");
          assert.equal(runtime.workflowControls[0]?.target, fixture.runId);
          assert.equal(runtime.workflowControls[0]?.policy, "continue-existing-session");
          assert.equal(runtime.workflowControls[1]?.action, "abort");
          assert.equal(runtime.workflowControls[1]?.target, fixture.runId);
          assert.deepEqual(sessions[0]?.resumeCursor, {
            schemaVersion: 1,
            provider: "pi",
            providerInstanceId: "pi",
            sessionFile: "/tmp/pi-session.json",
          });
        }),
      {
        resumeCursor: makePiResumeCursor({
          sessionFile: "/tmp/pi-session.json",
          activeWorkflowRuns: [
            { runId: fixture.runId, lastSequence: 1, runDir: fixture.runDir, status: "paused" },
          ],
        }),
      },
    );
  });

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
