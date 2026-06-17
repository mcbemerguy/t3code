// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makePiAdapter, type PiAdapterShape } from "./PiAdapter.ts";
import { type PiWorkflowMonitorOptions } from "./PiWorkflowMonitor.ts";
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
  statsResponses: Array<unknown> = [];
  statsReadCount = 0;
  messages: unknown = [{ id: "message-turn-1", role: "assistant", content: "hello" }];
  promptScript: ((runtime: FakePiRuntime) => Effect.Effect<void>) | undefined;
  promptInputs: Array<{ readonly message: string; readonly images?: ReadonlyArray<unknown> }> = [];
  extensionUiResponses: Array<PiExtensionUiResponseInput> = [];
  workflowControls: Array<PiWorkflowControlInput> = [];
  modelSelections: Array<{ provider: string; modelId: string }> = [];
  thinkingLevels: Array<string> = [];
  modelOptionOperations: Array<string> = [];
  currentModel: string | undefined;

  startImpl = vi.fn(() => Promise.resolve(this.session("ready")));
  promptImpl = vi.fn(
    async (_input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) =>
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

  prompt(input: { readonly message: string; readonly images?: ReadonlyArray<unknown> }) {
    this.promptInputs.push(input);
    const script = this.promptScript;
    const runPrompt = this.promptImpl;
    return (script ? script(this) : Effect.void).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => runPrompt(input),
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
      this.modelOptionOperations.push(`set_model:${provider}/${modelId}`);
      this.currentModel = `${provider}/${modelId}`;
      return {};
    });
  setThinkingLevel = (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") =>
    Effect.sync(() => {
      this.thinkingLevels.push(level);
      this.modelOptionOperations.push(`set_thinking_level:${level}`);
      return {};
    });
  getSessionStats = Effect.suspend(() => {
    this.statsReadCount += 1;
    const response = this.statsResponses.length > 0 ? this.statsResponses.shift() : this.stats;
    return response instanceof Error
      ? Effect.fail(new PiRpcLifecycleError(response.message, response))
      : Effect.succeed(response);
  });
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

function withHarness<T, R = never>(
  configure: ((runtime: FakePiRuntime) => void) | undefined,
  use: (harness: {
    adapter: PiAdapterShape;
    runtime: FakePiRuntime;
  }) => Effect.Effect<T, ProviderAdapterError, R>,
  startInput?: Partial<ProviderSessionStartInput>,
  adapterOptions?: {
    readonly instanceId?: ProviderInstanceId;
    readonly usageDebounceMs?: number;
    readonly workflowMonitor?: PiWorkflowMonitorOptions;
  },
) {
  const runtimes: Array<FakePiRuntime> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "pi" },
        {
          usageDebounceMs: adapterOptions?.usageDebounceMs ?? 0,
          ...(adapterOptions?.instanceId ? { instanceId: adapterOptions.instanceId } : {}),
          ...(adapterOptions?.workflowMonitor
            ? { workflowMonitor: adapterOptions.workflowMonitor }
            : {}),
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
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-adapter-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
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

function collectEventsThroughTurnCompleted(
  adapter: PiAdapterShape,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<Array<ProviderRuntimeEvent>> {
  return Stream.runCollect(
    adapter.streamEvents.pipe(
      Stream.filter((event) => predicate(event) || event.type === "turn.completed"),
      Stream.takeUntil((event) => event.type === "turn.completed"),
    ),
  ).pipe(Effect.map((events) => Array.from(events) as Array<ProviderRuntimeEvent>));
}

function isUsageEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "thread.token-usage.updated";
}

function usageUsedTokens(event: ProviderRuntimeEvent): number | undefined {
  return event.type === "thread.token-usage.updated" ? event.payload.usage.usedTokens : undefined;
}

function usageMaxTokens(event: ProviderRuntimeEvent): number | undefined {
  return event.type === "thread.token-usage.updated" ? event.payload.usage.maxTokens : undefined;
}

function piStats(usedTokens: number, maxTokens = 272_000) {
  return {
    tokens: { input: Math.max(usedTokens - 10, 0), output: 10, total: usedTokens },
    contextUsage: { tokens: usedTokens, contextWindow: maxTokens },
  };
}

type WorkflowRunFixture = {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly auditPath: string;
};

function createWorkflowRunFixture(input: {
  readonly runId?: string;
  readonly status?: string;
  readonly events?: ReadonlyArray<Record<string, unknown>>;
}): WorkflowRunFixture {
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

function appendWorkflowFixtureEvents(
  fixture: WorkflowRunFixture,
  events: ReadonlyArray<Record<string, unknown>>,
) {
  appendFileSync(
    join(fixture.runDir, "events.jsonl"),
    events
      .map((event) =>
        JSON.stringify({
          runId: fixture.runId,
          workflowId: "review-fix",
          runDir: fixture.runDir,
          auditPath: fixture.auditPath,
          ...event,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
}

function writeWorkflowFixtureStatus(fixture: WorkflowRunFixture, status: string) {
  writeFileSync(
    join(fixture.runDir, "run.json"),
    `${JSON.stringify({
      id: fixture.runId,
      workflowId: "review-fix",
      commandName: "workflow:review-fix",
      cwd: process.cwd(),
      runDir: fixture.runDir,
      auditPath: fixture.auditPath,
      status,
      endedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
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

  it.effect("forwards composer image attachments to Pi prompt input", () => {
    const attachment = {
      type: "image" as const,
      id: "thread-pi-adapter-123e4567-e89b-12d3-a456-426614174000",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };

    return withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig;
        writeFileSync(
          join(serverConfig.attachmentsDir, attachmentRelativePath(attachment)),
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );

        yield* adapter.sendTurn({
          threadId,
          input: "describe this image",
          attachments: [attachment],
        });

        assert.equal(runtime.promptInputs.length, 1);
        assert.deepEqual(runtime.promptInputs[0]?.images, [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw==",
          },
        ]);
      }),
    );
  });

  it.effect("forwards composer image attachments to Pi steering input", () => {
    const attachment = {
      type: "image" as const,
      id: "thread-pi-adapter-123e4567-e89b-12d3-a456-426614174001",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };

    return withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig;
        writeFileSync(
          join(serverConfig.attachmentsDir, attachmentRelativePath(attachment)),
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        );

        yield* adapter.sendTurn({ threadId, input: "start" });
        yield* adapter.sendTurn({ threadId, input: "include this", attachments: [attachment] });
        yield* adapter.sendActiveTurnInput({
          threadId,
          input: "direct steer",
          attachments: [attachment],
        });

        assert.deepEqual(runtime.steerImpl.mock.calls[0]?.[0].images, [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw==",
          },
        ]);
        assert.deepEqual(runtime.steerImpl.mock.calls[1]?.[0].images, [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw==",
          },
        ]);
      }),
    );
  });

  it.effect("fails Pi image attachment materialization like other provider adapters", () =>
    withHarness(undefined, ({ adapter }) =>
      Effect.gen(function* () {
        const invalid = yield* adapter
          .sendTurn({
            threadId,
            input: "bad",
            attachments: [
              {
                type: "image" as const,
                id: "../bad",
                name: "bad.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        if (invalid._tag === "Failure") {
          assert.equal(invalid.failure._tag, "ProviderAdapterRequestError");
          assert.equal(invalid.failure.detail, "Invalid attachment id '../bad'.");
        }

        const missing = yield* adapter
          .sendTurn({
            threadId,
            input: "missing",
            attachments: [
              {
                type: "image" as const,
                id: "thread-pi-adapter-123e4567-e89b-12d3-a456-426614174002",
                name: "missing.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(missing._tag, "Failure");
        if (missing._tag === "Failure") {
          assert.equal(missing.failure._tag, "ProviderAdapterRequestError");
          assert.equal(missing.failure.detail.startsWith("Failed to read attachment file:"), true);
        }
      }),
    ),
  );

  it.effect("does not apply Pi model selection when image attachment materialization fails", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const invalid = yield* adapter
          .sendTurn({
            threadId,
            input: "bad",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "mock/model-b",
              options: [{ id: "reasoning", value: "high" }],
            },
            attachments: [
              {
                type: "image" as const,
                id: "../bad",
                name: "bad.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");

        const missing = yield* adapter
          .sendTurn({
            threadId,
            input: "missing",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "mock/model-c",
              options: [{ id: "reasoning", value: "medium" }],
            },
            attachments: [
              {
                type: "image" as const,
                id: "thread-pi-adapter-123e4567-e89b-12d3-a456-426614174003",
                name: "missing.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(missing._tag, "Failure");
        assert.deepEqual(runtime.modelSelections, []);
        assert.deepEqual(runtime.thinkingLevels, []);
        assert.equal(runtime.promptImpl.mock.calls.length, 0);
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

  it.effect("refreshes native Pi usage on live event boundaries", () =>
    withHarness(
      (fake) => {
        fake.statsResponses = [
          piStats(100),
          piStats(200),
          piStats(300),
          piStats(400),
          piStats(500),
        ];
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_start" },
            });
            yield* rt.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_end" },
            });

            yield* rt.emit({
              type: "tool_execution_start",
              toolCallId: "tool-usage",
              toolName: "bash",
              args: { command: "echo ok" },
            });
            yield* rt.emit({
              type: "tool_execution_end",
              toolCallId: "tool-usage",
              result: { stdout: "ok" },
            });

            yield* rt.emit({ type: "auto_compaction_end" });

            yield* rt.emit({
              type: "message_end",
              message: { role: "assistant", content: "done" },
            });

            yield* rt.emit({ type: "prompt_end", success: true });
          });
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId, input: "exercise usage boundaries" });
          const events = yield* collectEvents(adapter, 5, isUsageEvent);

          assert.deepEqual(events.map(usageUsedTokens), [100, 200, 300, 400, 500]);
        }),
    ),
  );

  it.effect("continues scheduling usage refreshes after a stats failure", () =>
    withHarness(
      (fake) => {
        fake.statsResponses = [new Error("stats unavailable"), piStats(900)];
      },
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(adapter, 1, isUsageEvent).pipe(
            Effect.timeout("1 second"),
            Effect.orDie,
            Effect.forkChild,
          );
          yield* runtime.emit({
            type: "message_end",
            message: { role: "assistant", content: "first" },
          });
          yield* Effect.yieldNow;
          yield* TestClock.adjust("100 millis");
          assert.equal(runtime.statsReadCount, 1);

          yield* runtime.emit({
            type: "message_end",
            message: { role: "assistant", content: "second" },
          });
          yield* Effect.yieldNow;
          yield* TestClock.adjust("100 millis");
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(runtime.statsReadCount, 2);
          assert.equal(usageUsedTokens(events[0]!), 900);
        }),
      undefined,
      { usageDebounceMs: 50 },
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels pending usage refresh timers when a Pi session stops", () =>
    withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          yield* runtime.emit({
            type: "message_end",
            message: { role: "assistant", content: "pending" },
          });
          yield* Effect.yieldNow;
          yield* adapter.stopSession(threadId);
          yield* TestClock.adjust("1 second");

          assert.equal(runtime.statsReadCount, 0);
        }),
      undefined,
      { usageDebounceMs: 500 },
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces a final native Pi usage refresh after prompt completion", () =>
    withHarness(
      (fake) => {
        fake.stats = piStats(613);
        fake.promptScript = (rt) => rt.emit({ type: "agent_end", success: true });
        fake.promptImpl = vi.fn(async () => {
          fake.stats = piStats(42_000);
          return {
            threadId: fake.options.threadId,
            turnId: TurnId.make("pi-provider-turn"),
          } satisfies ProviderTurnStartResult;
        });
      },
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const throughCompletionFiber = yield* collectEventsThroughTurnCompleted(
            adapter,
            isUsageEvent,
          ).pipe(Effect.forkChild);
          yield* adapter.sendTurn({ threadId, input: "final usage grows after terminal event" });
          const throughCompletion = (yield* Fiber.join(throughCompletionFiber)).filter(
            isUsageEvent,
          );
          const afterCompletionFiber = yield* collectEvents(adapter, 1, isUsageEvent).pipe(
            Effect.timeout("1 second"),
            Effect.orDie,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          const afterCompletion = yield* Fiber.join(afterCompletionFiber);
          const events = [...throughCompletion, ...afterCompletion];
          const latest = events.at(-1);

          assert.equal(runtime.statsReadCount >= 2, true);
          assert.equal(usageUsedTokens(latest!), 42_000);
          assert.equal(usageMaxTokens(latest!), 272_000);
        }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves pending compaction markers when forcing final Pi usage", () =>
    withHarness(
      (fake) => {
        fake.statsResponses = [piStats(80_000), piStats(1_000)];
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({ type: "auto_compaction_end" });
            yield* rt.emit({ type: "prompt_end", success: true });
          });
      },
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(adapter, 2, isUsageEvent).pipe(
            Effect.timeout("5 seconds"),
            Effect.orDie,
            Effect.forkChild,
          );

          yield* runtime.emit({
            type: "message_end",
            message: { role: "assistant", content: "seed high usage" },
          });
          yield* Effect.yieldNow;
          yield* TestClock.adjust("600 millis");
          yield* adapter.sendTurn({ threadId, input: "compact" });
          const events = yield* Fiber.join(eventsFiber);

          assert.deepEqual(events.map(usageUsedTokens), [80_000, 1_000]);
        }),
      undefined,
      { usageDebounceMs: 500 },
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forces a final native Pi usage refresh after prompt failure", () =>
    withHarness(
      (fake) => {
        fake.stats = piStats(777);
        fake.promptImpl.mockRejectedValueOnce(new Error("prompt failed"));
      },
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEvents(adapter, 1, isUsageEvent).pipe(
            Effect.timeout("1 second"),
            Effect.orDie,
            Effect.forkChild,
          );
          const result = yield* adapter
            .sendTurn({ threadId, input: "fail after usage changes" })
            .pipe(Effect.result);
          const events = yield* Fiber.join(eventsFiber);

          assert.equal(result._tag, "Failure");
          assert.equal(runtime.statsReadCount, 1);
          assert.equal(usageUsedTokens(events[0]!), 777);
        }),
    ),
  );

  it.effect("does not let stale parent stats overwrite richer live workflow usage", () =>
    withHarness(
      (fake) => {
        fake.stats = piStats(613);
        fake.promptScript = (rt) =>
          Effect.gen(function* () {
            yield* rt.emit({
              type: "context_usage_update",
              runId: "run-usage-ordering",
              workflowId: "review-fix",
              sequence: 1,
              usage: {
                context: { usedTokens: 80_000, maxTokens: 272_000 },
                totals: { inputTokens: 74_000, outputTokens: 6_000 },
              },
            });
            yield* rt.emit({ type: "agent_end", success: true });
          });
      },
      ({ adapter }) =>
        Effect.gen(function* () {
          const eventsFiber = yield* collectEventsThroughTurnCompleted(adapter, isUsageEvent).pipe(
            Effect.forkChild,
          );
          yield* adapter.sendTurn({ threadId, input: "/workflow:review-fix" });
          const events = (yield* Fiber.join(eventsFiber)).filter(isUsageEvent);
          const workflowUsageIndex = events.findIndex(
            (event) => event.raw?.source === "pi.workflow.artifact",
          );
          const laterUsages = events.slice(workflowUsageIndex + 1).map(usageUsedTokens);

          assert.notEqual(workflowUsageIndex, -1);
          assert.equal(usageUsedTokens(events.at(-1)!), 80_000);
          assert.equal(
            laterUsages.some((usedTokens) => usedTokens !== undefined && usedTokens < 80_000),
            false,
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
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          const editStartObserved = yield* Deferred.make<void>();
          runtime.promptScript = (rt) =>
            Effect.gen(function* () {
              yield* rt.emit({
                type: "tool_execution_start",
                toolCallId: "edit-1",
                toolName: "edit",
                args: { path: "note.txt" },
              });
              yield* Deferred.await(editStartObserved);
              writeFileSync(join(root, "note.txt"), "new\n", "utf8");
              yield* rt.emit({
                type: "tool_execution_end",
                toolCallId: "edit-1",
                result: { content: [{ type: "text", text: "edited" }] },
              });
            });
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "item.started" ||
                event.type === "turn.diff.updated" ||
                event.type === "item.completed",
            ),
            Stream.tap((event) =>
              event.type === "item.started"
                ? Deferred.succeed(editStartObserved, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.map((events) => Array.from(events) as Array<ProviderRuntimeEvent>),
            Effect.forkChild,
          );
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

  it.effect("applies Pi reasoning after concrete model switches", () =>
    withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          assert.deepEqual(runtime.modelOptionOperations, [
            "set_model:mock/model-a",
            "set_thinking_level:low",
          ]);

          yield* adapter.sendTurn({
            threadId,
            input: "switch",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "mock/model-b",
              options: [{ id: "reasoning", value: "high" }],
            },
          });

          assert.deepEqual(runtime.modelOptionOperations, [
            "set_model:mock/model-a",
            "set_thinking_level:low",
            "set_model:mock/model-b",
            "set_thinking_level:high",
          ]);
        }),
      {
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "mock/model-a",
          options: [{ id: "reasoning", value: "low" }],
        },
      },
    ),
  );

  it.effect("applies Pi reasoning for the default model without switching models", () =>
    withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          assert.deepEqual(runtime.modelSelections, []);
          assert.deepEqual(runtime.thinkingLevels, ["high"]);

          yield* adapter.sendTurn({
            threadId,
            input: "default reasoning",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "default",
              options: [{ id: "reasoning", value: "medium" }],
            },
          });

          assert.deepEqual(runtime.modelSelections, []);
          assert.deepEqual(runtime.thinkingLevels, ["high", "medium"]);
          assert.equal(runtime.promptImpl.mock.calls.length, 1);
        }),
      {
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "default",
          options: [{ id: "reasoning", value: "high" }],
        },
      },
    ),
  );

  it.effect("ignores Pi fastMode selections because Pi has no writable Fast RPC", () =>
    withHarness(
      undefined,
      ({ adapter, runtime }) =>
        Effect.gen(function* () {
          assert.equal(runtime.modelOptionOperations.length, 0);
          assert.equal(runtime.promptInputs.length, 0);

          yield* adapter.sendTurn({
            threadId,
            input: "use pi without fast hack",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "default",
              options: [{ id: "fastMode", value: true }],
            },
          });

          assert.deepEqual(runtime.modelOptionOperations, []);
          assert.deepEqual(
            runtime.promptInputs.map((input) => input.message),
            ["use pi without fast hack"],
          );
        }),
      {
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "default",
          options: [{ id: "fastMode", value: true }],
        },
      },
    ),
  );

  it.effect("rejects invalid Pi reasoning before switching concrete models", () =>
    withHarness(undefined, ({ adapter, runtime }) =>
      Effect.gen(function* () {
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "bad reasoning",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "mock/model-b",
              options: [{ id: "reasoning", value: "turbo" }],
            },
          })
          .pipe(Effect.flip, Effect.orDie);

        assert.match(error.message, /thinking level 'turbo'/);
        assert.deepEqual(runtime.modelSelections, []);
        assert.deepEqual(runtime.thinkingLevels, []);
        assert.equal(runtime.promptImpl.mock.calls.length, 0);
      }),
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
          { runId: "aborting", lastSequence: 5, runDir: "/tmp/aborting", status: "aborting" },
          { runId: "done", lastSequence: 9, status: "completed" },
        ],
      });
      assert.deepEqual(cursor, {
        schemaVersion: 1,
        provider: "pi",
        sessionFile: "/tmp/pi-session.json",
        workflows: {
          activeRuns: [
            { runId: "active", lastSequence: 4, runDir: "/tmp/run", status: "running" },
            { runId: "aborting", lastSequence: 5, runDir: "/tmp/aborting", status: "aborting" },
          ],
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

  it.effect("keeps workflow monitors alive long enough to emit usage after abort controls", () => {
    const fixture = createWorkflowRunFixture({
      status: "running",
      events: [{ type: "run_start", sequence: 1 }],
    });
    return withHarness(
      undefined,
      ({ adapter }) =>
        Effect.gen(function* () {
          const usageFiber = yield* collectEvents(
            adapter,
            1,
            (event) =>
              event.type === "thread.token-usage.updated" &&
              event.raw?.source === "pi.workflow.artifact",
          ).pipe(Effect.timeout("2 seconds"), Effect.orDie, Effect.forkChild);

          yield* adapter.sendTurn({ threadId, input: `/workflow:abort ${fixture.runId}` });
          appendWorkflowFixtureEvents(fixture, [
            {
              type: "context_usage_update",
              sequence: 2,
              usage: { context: { usedTokens: 45_000, maxTokens: 272_000 } },
            },
            { type: "run_end", sequence: 3, status: "aborted" },
          ]);
          writeWorkflowFixtureStatus(fixture, "aborted");
          const [usageEvent] = yield* Fiber.join(usageFiber);
          const sessions = yield* adapter.listSessions();

          assert.equal(usageUsedTokens(usageEvent!), 45_000);
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
  });

  it.effect("keeps restored pending abort monitors alive for delayed trailing usage", () => {
    const fixture = createWorkflowRunFixture({
      status: "running",
      events: [{ type: "run_start", sequence: 1 }],
    });
    return Effect.gen(function* () {
      const resumeCursor = yield* withHarness(
        undefined,
        ({ adapter }) =>
          Effect.gen(function* () {
            yield* adapter.sendTurn({ threadId, input: `/workflow:abort ${fixture.runId}` });
            const sessions = yield* adapter.listSessions();
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
                    status: "aborting",
                  },
                ],
              },
            });
            return sessions[0]?.resumeCursor;
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

      writeWorkflowFixtureStatus(fixture, "aborted");

      yield* withHarness(
        undefined,
        ({ adapter }) =>
          Effect.gen(function* () {
            const eventsFiber = yield* collectEvents(
              adapter,
              2,
              (event) =>
                (event.type === "thread.token-usage.updated" || event.type === "task.completed") &&
                event.raw?.source === "pi.workflow.artifact",
            ).pipe(Effect.timeout("2 seconds"), Effect.orDie, Effect.forkChild);
            yield* Effect.yieldNow;
            appendWorkflowFixtureEvents(fixture, [
              {
                type: "context_usage_update",
                sequence: 2,
                usage: { context: { usedTokens: 55_000, maxTokens: 272_000 } },
              },
              { type: "run_end", sequence: 3, status: "aborted" },
            ]);
            const events = yield* Fiber.join(eventsFiber);
            const sessions = yield* adapter.listSessions();

            assert.equal(usageUsedTokens(events[0]!), 55_000);
            assert.equal(events[1]?.type, "task.completed");
            assert.deepEqual(sessions[0]?.resumeCursor, {
              schemaVersion: 1,
              provider: "pi",
              providerInstanceId: "pi",
              sessionFile: "/tmp/pi-session.json",
            });
          }),
        { resumeCursor },
        { workflowMonitor: { terminalFallbackGraceMs: 0 } },
      );
    });
  });

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
            workflows: {
              activeRuns: [
                {
                  runId: fixture.runId,
                  lastSequence: 1,
                  runDir: fixture.runDir,
                  status: "aborting",
                },
              ],
            },
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
