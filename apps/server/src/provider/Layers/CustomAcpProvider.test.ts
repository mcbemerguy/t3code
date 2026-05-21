// @effect-diagnostics nodeBuiltinImport:off
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
        schemaVersion: 1,
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

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "user-input.requested"
          ? Deferred.succeed(requested, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

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
