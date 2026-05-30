// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CustomAcpSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type ServerProviderSlashCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { CustomAcpDriver } from "../Drivers/CustomAcpDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import { checkCustomAcpProviderStatus } from "./CustomAcpProvider.ts";
import { parseCustomAcpResume } from "../acp/PiWorkflowExtension.ts";
import { makeGenericAcpAdapter } from "./GenericAcpAdapter.ts";

const decodeCustomAcpSettings = Schema.decodeSync(CustomAcpSettings);
const customAcpDriver = ProviderDriverKind.make("customAcp");
const customAcpInstanceId = ProviderInstanceId.make("customAcp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "custom-acp-provider-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function makeCustomAcpSettings(overrides: Partial<CustomAcpSettings> = {}): CustomAcpSettings {
  return decodeCustomAcpSettings({
    command: bunExe,
    args: mockAgentPath,
    ...overrides,
  });
}

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "custom-acp-test-"));
  return path.join(dir, name);
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function jsonRpcMethods(entries: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> {
  return entries.flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
}

describe("Custom ACP provider", () => {
  it.effect("hydrates an explicit providerInstances.customAcp entry as a live provider", () =>
    Effect.gen(function* () {
      const configMap: ProviderInstanceConfigMap = {
        [customAcpInstanceId]: {
          driver: customAcpDriver,
          displayName: "Local ACP",
          enabled: false,
          config: makeCustomAcpSettings({ enabled: false, command: "" }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CustomAcpDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(customAcpInstanceId);
      assert.isDefined(instance);
      assert.equal(instance?.driverKind, customAcpDriver);
      assert.equal(instance?.displayName, "Local ACP");
      assert.equal(yield* instance!.adapter.hasSession(ThreadId.make("missing")), false);

      const snapshot = yield* instance!.snapshot.getSnapshot;
      assert.equal(snapshot.instanceId, customAcpInstanceId);
      assert.equal(snapshot.driver, customAcpDriver);
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.deepStrictEqual(yield* registry.listUnavailable, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("probes the ACP mock without auth unless authMethodId is configured", () =>
    Effect.gen(function* () {
      const noAuthLog = yield* Effect.promise(() => tempFile("no-auth.jsonl"));
      const noAuth = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({ env: envText({ T3_ACP_REQUEST_LOG_PATH: noAuthLog }) }),
      );
      assert.equal(noAuth.status, "ready");
      assert.include(
        noAuth.models.map((model) => model.slug),
        "composer-2",
      );
      const noAuthMethods = jsonRpcMethods(yield* Effect.promise(() => readJsonLines(noAuthLog)));
      assert.include(noAuthMethods, "initialize");
      assert.notInclude(noAuthMethods, "authenticate");

      const authLog = yield* Effect.promise(() => tempFile("auth.jsonl"));
      const withAuth = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({
          authMethodId: "mock_login",
          env: envText({ T3_ACP_REQUEST_LOG_PATH: authLog }),
        }),
      );
      assert.equal(withAuth.status, "ready");
      const authMethods = jsonRpcMethods(yield* Effect.promise(() => readJsonLines(authLog)));
      assert.include(authMethods, "authenticate");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("falls back to manual/default models when the command cannot be probed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({ command: "", manualModels: "manual-one\nmanual-two" }),
      );
      assert.equal(snapshot.status, "error");
      assert.deepStrictEqual(
        snapshot.models.map((model) => model.slug),
        ["manual-one", "manual-two"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("falls back to the default model when ACP discovery exposes no model config", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({ env: envText({ T3_ACP_OMIT_MODEL_CONFIG: "1" }) }),
      );
      assert.equal(snapshot.status, "ready");
      assert.deepStrictEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("derives reasoning traits from ACP thought-level config options", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({
          env: envText({ T3_ACP_EMIT_THOUGHT_LEVEL_CONFIG: "1" }),
          manualModels: "manual-one",
        }),
      );
      assert.equal(snapshot.status, "ready");
      const modelsBySlug = new Map(snapshot.models.map((model) => [model.slug, model]));

      for (const slug of ["default", "manual-one"]) {
        const model = modelsBySlug.get(slug);
        assert.isDefined(model);
        const descriptor = model!.capabilities?.optionDescriptors?.[0];
        assert.deepStrictEqual(descriptor, {
          id: "reasoning",
          label: "Thinking level",
          type: "select",
          options: [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        });
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("attaches reasoning traits to fallback models when ACP exposes no model config", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_THOUGHT_LEVEL_CONFIG: "1",
            T3_ACP_OMIT_MODEL_CONFIG: "1",
          }),
        }),
      );
      assert.equal(snapshot.status, "ready");
      const fallbackModel = snapshot.models[0];
      assert.isDefined(fallbackModel);
      const descriptor = fallbackModel!.capabilities?.optionDescriptors?.[0];
      assert.equal(fallbackModel!.slug, "default");
      assert.equal(descriptor?.id, "reasoning");
      assert.equal(descriptor?.currentValue, "medium");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("includes ACP available commands from provider status discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCustomAcpProviderStatus(
        makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_AVAILABLE_COMMANDS: "1" }) }),
      );
      assert.equal(snapshot.status, "ready");
      assert.deepStrictEqual(snapshot.slashCommands, [
        {
          name: "mock",
          description: "Run a mock command",
          input: { hint: "optional input" },
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "publishes live ACP available command updates through the generic adapter callback",
    () =>
      Effect.gen(function* () {
        const updatedCommands = yield* Deferred.make<ReadonlyArray<ServerProviderSlashCommand>>();
        const adapter = yield* makeGenericAcpAdapter(
          makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_AVAILABLE_COMMANDS: "1" }) }),
          {
            instanceId: customAcpInstanceId,
            onSlashCommandsUpdated: (commands) => Deferred.succeed(updatedCommands, commands),
          },
        );
        const threadId = ThreadId.make("custom-acp-available-commands");

        yield* adapter.startSession({
          threadId,
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        assert.deepStrictEqual(yield* Deferred.await(updatedCommands), [
          {
            name: "mock",
            description: "Run a mock command",
            input: { hint: "optional input" },
          },
        ]);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "refreshes the managed provider snapshot when a live ACP session reports commands",
    () =>
      Effect.gen(function* () {
        const configMap: ProviderInstanceConfigMap = {
          [customAcpInstanceId]: {
            driver: customAcpDriver,
            displayName: "Local ACP",
            enabled: true,
            config: makeCustomAcpSettings({
              env: envText({ T3_ACP_EMIT_AVAILABLE_COMMANDS_ON_PROMPT: "1" }),
            }),
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CustomAcpDriver],
          configMap,
        });
        const instance = yield* registry.getInstance(customAcpInstanceId);
        assert.isDefined(instance);

        const baseline = yield* instance!.snapshot.refresh;
        assert.equal(baseline.instanceId, customAcpInstanceId);
        assert.equal(baseline.driver, customAcpDriver);
        assert.equal(baseline.displayName, "Local ACP");
        assert.equal(baseline.status, "ready");
        assert.deepStrictEqual(baseline.slashCommands, []);

        const snapshotFiber = yield* instance!.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "mock"),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = ThreadId.make("custom-acp-managed-available-commands");
        yield* instance!.adapter.startSession({
          threadId,
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* instance!.adapter.sendTurn({ threadId, input: "refresh commands", attachments: [] });

        const updated = Array.from(yield* Fiber.join(snapshotFiber))[0] as
          | ServerProvider
          | undefined;
        assert.isDefined(updated);
        assert.equal(updated!.instanceId, baseline.instanceId);
        assert.equal(updated!.driver, baseline.driver);
        assert.equal(updated!.displayName, baseline.displayName);
        assert.equal(updated!.status, baseline.status);
        assert.deepStrictEqual(updated!.auth, baseline.auth);
        assert.deepStrictEqual(updated!.models, baseline.models);
        assert.equal(updated!.version, baseline.version);
        assert.deepStrictEqual(updated!.slashCommands, [
          {
            name: "mock",
            description: "Run a mock command",
            input: { hint: "optional input" },
          },
        ]);

        const refreshed = yield* instance!.snapshot.refresh;
        assert.deepStrictEqual(refreshed.slashCommands, updated!.slashCommands);
        yield* instance!.adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("starts, prompts, streams events, and records the custom ACP resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(makeCustomAcpSettings(), {
        instanceId: customAcpInstanceId,
      });
      const threadId = ThreadId.make("custom-acp-mock-thread");
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: customAcpInstanceId, model: "default" },
      });

      assert.equal(session.provider, customAcpDriver);
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 2,
        provider: customAcpDriver,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello mock", attachments: [] });
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((event) => event.type);
      for (const type of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, type);
      }
      assert.isTrue(runtimeEvents.every((event) => event.provider === customAcpDriver));
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("emits a failed turn completion when ACP prompt fails after start", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_FAIL_PROMPT: "1",
            T3_ACP_FAIL_PROMPT_DETAIL: "Mock prompt failed after turn start",
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-prompt-failure-after-start");
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId || event.type !== "turn.completed") return Effect.void;
        return Deferred.succeed(completed, event).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] });
      assert.equal(turn.threadId, threadId);

      const completedEvent = yield* Deferred.await(completed);
      assert.equal(completedEvent.payload.state, "failed");
      assert.equal(completedEvent.payload.stopReason, "session/prompt failed");
      assert.equal(completedEvent.payload.errorMessage, "Mock prompt failed after turn start");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("handles ask-question requests and resolves them through respondToUserInput", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_ASK_QUESTION: "1" }) }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-ask-question");
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved = yield* Deferred.make<void>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask", attachments: [] })
        .pipe(Effect.forkChild);

      const request = yield* Deferred.await(requested);
      assert.deepStrictEqual(
        request.payload.questions[0]?.options.map((option) => option.label),
        ["Workspace", "Session"],
      );
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(request.requestId)),
        {
          scope: "Workspace",
        },
      );
      yield* Deferred.await(resolved);
      yield* Fiber.join(turnFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles stale ask-question waits on interrupt and rejects late responses", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_ASK_QUESTION: "1" }) }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-stale-ask-question");
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask", attachments: [] })
        .pipe(Effect.forkChild);
      const request = yield* Deferred.await(requested);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(turnFiber);
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.isDefined(request.turnId);
      assert.equal(resolvedEvent.turnId, request.turnId);

      const late = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make(String(request.requestId)), {
          scope: "Workspace",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
      if (Exit.isFailure(late)) {
        assert.match(Cause.pretty(late.cause), /unknown pending user-input request/i);
      }
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "streams post-interrupt ACP updates on the original turn before cancellation completes",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeGenericAcpAdapter(
          makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_TOOL_CALLS: "1" }) }),
          { instanceId: customAcpInstanceId },
        );
        const threadId = ThreadId.make("custom-acp-post-interrupt-updates");
        const requested =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
        const completed =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
        const events: Array<ProviderRuntimeEvent> = [];

        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId !== threadId) return Effect.void;
          events.push(event);
          if (event.type === "request.opened") {
            return Deferred.succeed(requested, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            return Deferred.succeed(completed, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "needs approval", attachments: [] })
          .pipe(Effect.forkChild);

        const openedEvent = yield* Deferred.await(requested);
        const interruptEventCount = events.length;
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        const completedEvent = yield* Deferred.await(completed);
        const postInterruptEvents = events.slice(interruptEventCount);
        const completedIndex = postInterruptEvents.findIndex(
          (event) => event.type === "turn.completed",
        );
        const toolCompletedIndex = postInterruptEvents.findIndex(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        const contentIndex = postInterruptEvents.findIndex(
          (event) => event.type === "content.delta" && event.payload.delta === "hello from mock",
        );

        assert.isDefined(openedEvent.turnId);
        assert.isTrue(completedIndex >= 0);
        assert.isTrue(toolCompletedIndex >= 0 && toolCompletedIndex < completedIndex);
        assert.isTrue(contentIndex >= 0 && contentIndex < completedIndex);
        assert.equal(postInterruptEvents[toolCompletedIndex]?.turnId, openedEvent.turnId);
        assert.equal(postInterruptEvents[contentIndex]?.turnId, openedEvent.turnId);
        assert.equal(completedEvent.turnId, openedEvent.turnId);
        assert.equal(completedEvent.payload.state, "cancelled");
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("queues a new ACP prompt until cancelled-turn drain finishes", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({ env: envText({ T3_ACP_EMIT_TOOL_CALLS: "1" }) }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-queued-after-cancel");
      const firstRequested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const secondRequested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const events: Array<ProviderRuntimeEvent> = [];
      let requestCount = 0;

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        events.push(event);
        if (event.type !== "request.opened") return Effect.void;
        requestCount += 1;
        return (
          requestCount === 1
            ? Deferred.succeed(firstRequested, event)
            : requestCount === 2
              ? Deferred.succeed(secondRequested, event)
              : Effect.void
        ).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const firstTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);

      const firstOpenedEvent = yield* Deferred.await(firstRequested);
      yield* adapter.interruptTurn(threadId);
      const secondTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "next prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Fiber.join(firstTurnFiber);
      const secondOpenedEvent = yield* Deferred.await(secondRequested);

      assert.isDefined(firstOpenedEvent.turnId);
      assert.isDefined(secondOpenedEvent.turnId);
      assert.notEqual(secondOpenedEvent.turnId, firstOpenedEvent.turnId);

      const firstCompletedIndex = events.findIndex(
        (event) => event.type === "turn.completed" && event.turnId === firstOpenedEvent.turnId,
      );
      const secondStartedIndex = events.findIndex(
        (event) => event.type === "turn.started" && event.turnId === secondOpenedEvent.turnId,
      );
      assert.isTrue(firstCompletedIndex >= 0);
      assert.isTrue(secondStartedIndex > firstCompletedIndex);

      yield* adapter.stopSession(threadId);
      yield* Fiber.await(secondTurnFiber);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("suppresses prompt failures after a cancelled turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_FAIL_PROMPT_AFTER_CANCEL: "1",
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-cancelled-prompt-failure");
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      let completedCount = 0;

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "request.opened") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "request.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          completedCount += 1;
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);

      const openedEvent = yield* Deferred.await(requested);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turnFiber);

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.isDefined(openedEvent.turnId);
      assert.equal(resolvedEvent.turnId, openedEvent.turnId);
      const completedEvent = yield* Deferred.await(completed);
      assert.equal(completedEvent.payload.state, "cancelled");
      yield* Effect.yieldNow;
      assert.equal(completedCount, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "preserves strict pi ACP resume cursor across interrupted turns and resumes with session/load",
    () =>
      Effect.gen(function* () {
        const requestLog = yield* Effect.promise(() => tempFile("interrupted-resume.jsonl"));
        const adapter = yield* makeGenericAcpAdapter(
          makeCustomAcpSettings({
            env: envText({
              T3_ACP_ENABLE_PI_STEERING: "1",
              T3_ACP_EMIT_TOOL_CALLS: "1",
              T3_ACP_REQUEST_LOG_PATH: requestLog,
            }),
          }),
          { instanceId: customAcpInstanceId },
        );
        const threadId = ThreadId.make("custom-acp-interrupted-strict-resume");
        const requested = yield* Deferred.make<ProviderRuntimeEvent>();

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.threadId === threadId && event.type === "request.opened"
            ? Deferred.succeed(requested, event).pipe(Effect.ignore)
            : Effect.void,
        ).pipe(Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId,
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 2,
          provider: customAcpDriver,
          sessionId: "mock-session-1",
          requireSessionLoad: true,
        });

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "needs approval", attachments: [] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* adapter.interruptTurn(threadId);
        const turnResult = yield* Fiber.join(turnFiber);
        assert.deepStrictEqual(turnResult.resumeCursor, session.resumeCursor);

        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: turnResult.resumeCursor,
        });
        assert.deepStrictEqual(resumed.resumeCursor, session.resumeCursor);
        yield* adapter.stopSession(threadId);

        const methods = jsonRpcMethods(yield* Effect.promise(() => readJsonLines(requestLog)));
        assert.equal(methods.filter((method) => method === "session/new").length, 1);
        assert.include(methods, "session/load");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it("migrates custom ACP resume cursor version 1 to workflow-aware resume metadata", () => {
    const parsed = parseCustomAcpResume(customAcpDriver, {
      schemaVersion: 1,
      provider: customAcpDriver,
      sessionId: "legacy-session",
      requireSessionLoad: true,
    });
    expect(parsed).toEqual({
      sessionId: "legacy-session",
      requireResumeSession: true,
      activeWorkflowRuns: [],
    });
  });

  it("parses workflow-aware custom ACP resume cursors", () => {
    const parsed = parseCustomAcpResume(customAcpDriver, {
      schemaVersion: 2,
      provider: customAcpDriver,
      sessionId: "pi-session",
      workflows: {
        activeRuns: [{ runId: "workflow-run-1", lastSequence: 7, runDir: "/tmp/run" }],
      },
    });
    expect(parsed).toEqual({
      sessionId: "pi-session",
      requireResumeSession: false,
      activeWorkflowRuns: [{ runId: "workflow-run-1", lastSequence: 7, runDir: "/tmp/run" }],
    });
  });

  it.effect("fails strict custom ACP resume visibly instead of falling back to session/new", () =>
    Effect.gen(function* () {
      const requestLog = yield* Effect.promise(() => tempFile("strict-resume-failure.jsonl"));
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_FAIL_LOAD_SESSION: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
          }),
        }),
        { instanceId: customAcpInstanceId },
      );

      const failed = yield* adapter
        .startSession({
          threadId: ThreadId.make("custom-acp-strict-resume-failure"),
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            provider: customAcpDriver,
            sessionId: "missing-session",
            requireSessionLoad: true,
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed)) {
        assert.match(Cause.pretty(failed.cause), /Mock failed session\/load/);
      }
      const methods = jsonRpcMethods(yield* Effect.promise(() => readJsonLines(requestLog)));
      assert.include(methods, "session/load");
      assert.notInclude(methods, "session/new");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a healthy ACP session alive after cancel and prompt settlement", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_FAIL_PROMPT_AFTER_CANCEL: "1",
            T3_ACP_HANG_CANCEL: "1",
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-cancel-watchdog-settled");
      const requested = yield* Deferred.make<ProviderRuntimeEvent>();

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "request.opened"
          ? Deferred.succeed(requested, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requested);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turnFiber);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2_800)));

      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resolves the turn when a prompt does not produce a normal response after cancel", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_HANG_PROMPT_AFTER_CANCEL: "1",
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-cancel-settled-prompt-lag");
      const requested = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "request.opened"
          ? Deferred.succeed(requested, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requested);
      yield* adapter.interruptTurn(threadId);
      const turnResult = yield* Fiber.join(turnFiber);

      assert.equal(turnResult.threadId, threadId);
      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not duplicate cancelled completion after a late explicit interrupt", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({ T3_ACP_PROMPT_STOP_REASON_CANCELLED: "1" }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-late-cancel-interrupt");
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      let completedCount = 0;

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId || event.type !== "turn.completed") {
          return Effect.void;
        }
        completedCount += 1;
        return Deferred.succeed(completed, event).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const result = yield* adapter.sendTurn({
        threadId,
        input: "cancel normally",
        attachments: [],
      });
      const completedEvent = yield* Deferred.await(completed);
      assert.equal(completedEvent.payload.state, "cancelled");

      yield* adapter.interruptTurn(threadId, result.turnId);
      yield* Effect.yieldNow;

      assert.equal(completedCount, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("switches models through the generic ACP model config option", () =>
    Effect.gen(function* () {
      const requestLog = yield* Effect.promise(() => tempFile("model-switch.jsonl"));
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({ env: envText({ T3_ACP_REQUEST_LOG_PATH: requestLog }) }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-model-switch");

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        attachments: [],
        modelSelection: { instanceId: customAcpInstanceId, model: "composer-2" },
      });
      yield* adapter.stopSession(threadId);

      const entries = yield* Effect.promise(() => readJsonLines(requestLog));
      expect(
        entries.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "model" &&
            (entry.params as Record<string, unknown> | undefined)?.value === "composer-2",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("maps reasoning selections to ACP thought-level config options", () =>
    Effect.gen(function* () {
      const requestLog = yield* Effect.promise(() => tempFile("reasoning-switch.jsonl"));
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_THOUGHT_LEVEL_CONFIG: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-reasoning-switch");

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "switch reasoning",
        attachments: [],
        modelSelection: {
          instanceId: customAcpInstanceId,
          model: "default",
          options: [{ id: "reasoning", value: "high" }],
        },
      });
      yield* adapter.stopSession(threadId);

      const entries = yield* Effect.promise(() => readJsonLines(requestLog));
      expect(
        entries.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "thought_level" &&
            (entry.params as Record<string, unknown> | undefined)?.value === "high",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ignores stale reasoning selections that are not valid ACP option values", () =>
    Effect.gen(function* () {
      const requestLog = yield* Effect.promise(() => tempFile("invalid-reasoning-switch.jsonl"));
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({
            T3_ACP_EMIT_THOUGHT_LEVEL_CONFIG: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
          }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-invalid-reasoning-switch");

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "ignore invalid reasoning",
        attachments: [],
        modelSelection: {
          instanceId: customAcpInstanceId,
          model: "default",
          options: [{ id: "reasoning", value: "stale" }],
        },
      });
      yield* adapter.stopSession(threadId);

      const entries = yield* Effect.promise(() => readJsonLines(requestLog));
      expect(
        entries.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "thought_level",
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not write a fallback model when the ACP server exposes no model config", () =>
    Effect.gen(function* () {
      const requestLog = yield* Effect.promise(() => tempFile("no-model-config.jsonl"));
      const adapter = yield* makeGenericAcpAdapter(
        makeCustomAcpSettings({
          env: envText({ T3_ACP_OMIT_MODEL_CONFIG: "1", T3_ACP_REQUEST_LOG_PATH: requestLog }),
        }),
        { instanceId: customAcpInstanceId },
      );
      const threadId = ThreadId.make("custom-acp-no-model-config");

      yield* adapter.startSession({
        threadId,
        provider: customAcpDriver,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: customAcpInstanceId, model: "default" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "no model config",
        attachments: [],
        modelSelection: { instanceId: customAcpInstanceId, model: "composer-2" },
      });
      yield* adapter.stopSession(threadId);

      const entries = yield* Effect.promise(() => readJsonLines(requestLog));
      expect(
        entries.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "model",
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("returns a typed adapter error for invalid custom ACP env settings", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGenericAcpAdapter(makeCustomAcpSettings({ env: "BROKEN_ENV" }), {
        instanceId: customAcpInstanceId,
      });
      const failed = yield* adapter
        .startSession({
          threadId: ThreadId.make("custom-acp-invalid-env"),
          provider: customAcpDriver,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed)) {
        assert.match(Cause.pretty(failed.cause), /ProviderAdapterProcessError/);
        assert.match(Cause.pretty(failed.cause), /Invalid Custom ACP env line 1/);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
