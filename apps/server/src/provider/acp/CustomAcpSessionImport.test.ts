// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CustomAcpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type OrchestrationCommand,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  listCustomAcpExternalSessions,
  importCustomAcpExternalSession,
} from "./CustomAcpSessionImport.ts";
import { makeCustomAcpRuntime } from "./CustomAcpSupport.ts";

const decodeCustomAcpSettings = Schema.decodeSync(CustomAcpSettings);
const customAcpDriver = ProviderDriverKind.make("customAcp");
const customAcpInstanceId = ProviderInstanceId.make("customAcp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";

function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function makeCustomAcpSettings(overrides: Partial<CustomAcpSettings> = {}): CustomAcpSettings {
  return decodeCustomAcpSettings({ command: mockAgentCommand, args: mockAgentPath, ...overrides });
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function methods(entries: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> {
  return entries.flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
}

function settingsLayer(settings: CustomAcpSettings) {
  return ServerSettingsService.layerTest({
    providerInstances: {
      [customAcpInstanceId]: {
        driver: customAcpDriver,
        enabled: true,
        config: settings,
      },
    },
  });
}

let tempNameCounter = 0;

function uniqueTempName(prefix: string): string {
  tempNameCounter += 1;
  return `${prefix}-${process.pid}-${tempNameCounter}`;
}

const discoveryLayer = (settings: CustomAcpSettings) =>
  settingsLayer(settings).pipe(Layer.provideMerge(NodeServices.layer));

describe("Custom ACP external session import", () => {
  it.effect("lists sessions with initialize and session/list without session/new", () => {
    const requestLog = path.join(os.tmpdir(), `${uniqueTempName("custom-acp-import-list")}.jsonl`);
    return Effect.gen(function* () {
      const result = yield* listCustomAcpExternalSessions({
        providerInstanceId: customAcpInstanceId,
        cwd: process.cwd(),
      });

      assert.equal(result.sessions[0]?.sessionId, "external-session-1");
      assert.equal(result.sessions[0]?.cwd, process.cwd());
      assert.equal(result.nextCursor, "next-page");

      const loggedMethods = methods(yield* Effect.promise(() => readJsonLines(requestLog)));
      assert.include(loggedMethods, "initialize");
      assert.include(loggedMethods, "session/list");
      assert.notInclude(loggedMethods, "session/new");
    }).pipe(
      Effect.provide(
        discoveryLayer(
          makeCustomAcpSettings({
            env: envText({ T3_ACP_REQUEST_LOG_PATH: requestLog, T3_ACP_ENABLE_SESSION_LIST: "1" }),
          }),
        ),
      ),
    );
  });

  it.effect(
    "authenticates before listing when authMethodId is configured and passes cwd/cursor",
    () => {
      const requestLog = path.join(
        os.tmpdir(),
        `${uniqueTempName("custom-acp-import-auth-list")}.jsonl`,
      );
      return Effect.gen(function* () {
        const result = yield* listCustomAcpExternalSessions({
          providerInstanceId: customAcpInstanceId,
          cwd: process.cwd(),
          cursor: "cursor-1",
        });

        assert.equal(result.nextCursor, null);
        const entries = yield* Effect.promise(() => readJsonLines(requestLog));
        const loggedMethods = methods(entries);
        expect(loggedMethods.slice(0, 3)).toEqual(["initialize", "authenticate", "session/list"]);
        const listEntry = entries.find((entry) => entry.method === "session/list");
        expect(listEntry?.params).toMatchObject({ cwd: process.cwd(), cursor: "cursor-1" });
      }).pipe(
        Effect.provide(
          discoveryLayer(
            makeCustomAcpSettings({
              authMethodId: "mock-auth",
              env: envText({
                T3_ACP_REQUEST_LOG_PATH: requestLog,
                T3_ACP_ENABLE_SESSION_LIST: "1",
              }),
            }),
          ),
        ),
      );
    },
  );

  it.effect("filters out listed sessions outside the requested cwd", () => {
    const outsideCwd = path.join(os.tmpdir(), uniqueTempName("custom-acp-outside"));
    return Effect.gen(function* () {
      const result = yield* listCustomAcpExternalSessions({
        providerInstanceId: customAcpInstanceId,
        cwd: process.cwd(),
      });

      expect(result.sessions.map((session) => session.sessionId)).toEqual(["external-session-1"]);
      assert.equal(result.sessions[0]?.cwd, process.cwd());
    }).pipe(
      Effect.provide(
        discoveryLayer(
          makeCustomAcpSettings({
            env: envText({ T3_ACP_ENABLE_SESSION_LIST: "1", T3_ACP_LIST_EXTRA_CWD: outsideCwd }),
          }),
        ),
      ),
    );
  });

  it.effect("fails clearly when session/list is not advertised", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        listCustomAcpExternalSessions({
          providerInstanceId: customAcpInstanceId,
          cwd: process.cwd(),
        }),
      );
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(discoveryLayer(makeCustomAcpSettings()))),
  );

  it.effect(
    "strict Custom ACP resume does not fall back to session/new when session/load fails",
    () => {
      const requestLog = path.join(
        os.tmpdir(),
        `${uniqueTempName("custom-acp-import-strict-resume")}.jsonl`,
      );
      return Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeCustomAcpRuntime({
              settings: makeCustomAcpSettings({
                env: envText({
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_FAIL_LOAD_SESSION: "1",
                }),
              }),
              childProcessSpawner,
              cwd: process.cwd(),
              resumeSessionId: "external-session-1",
              requireResumeSession: true,
              clientInfo: { name: "t3-code", version: "0.0.0" },
            });
            return yield* Effect.exit(runtime.start());
          }),
        );

        assert.isTrue(exit._tag === "Failure");
        const loggedMethods = methods(yield* Effect.promise(() => readJsonLines(requestLog)));
        assert.include(loggedMethods, "session/load");
        assert.notInclude(loggedMethods, "session/new");
      }).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.effect(
    "imports by starting the provider with the selected resume cursor and dispatching binding metadata",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationCommand[] = [];
        let startInput: ProviderSessionStartInput | undefined;
        const now = "2026-05-23T00:00:00.000Z";
        const providerService: ProviderServiceShape = {
          startSession: (_threadId, input) => {
            startInput = input;
            return Effect.succeed({
              provider: customAcpDriver,
              providerInstanceId: customAcpInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: input.cwd,
              model: input.modelSelection?.model,
              threadId: input.threadId,
              resumeCursor: {
                schemaVersion: 1,
                provider: "customAcp",
                sessionId: "external-session-1",
              },
              createdAt: now,
              updatedAt: now,
            } satisfies ProviderSession);
          },
          sendTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: () => Effect.void,
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        };
        const orchestration: OrchestrationEngineShape = {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        };

        const result = yield* importCustomAcpExternalSession({
          providerInstanceId: customAcpInstanceId,
          projectId: ProjectId.make("project-1"),
          cwd: process.cwd(),
          sessionId: "external-session-1",
          title: "External session",
          updatedAt: now,
          modelSelection: { instanceId: customAcpInstanceId, model: "default" },
          runtimeMode: "full-access",
        }).pipe(
          Effect.provideService(ProviderService, providerService),
          Effect.provideService(OrchestrationEngineService, orchestration),
        );

        assert.equal(result.sequence, 3);
        expect(startInput?.resumeCursor).toEqual({
          schemaVersion: 1,
          provider: "customAcp",
          sessionId: "external-session-1",
          requireSessionLoad: true,
        });
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.session.set",
          "thread.activity.append",
        ]);
      }).pipe(Effect.provide(settingsLayer(makeCustomAcpSettings()))),
  );

  it.effect(
    "cleans up the created thread if the provider does not bind the requested resume session",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationCommand[] = [];
        let stopped = false;
        const now = "2026-05-23T00:00:00.000Z";
        const providerService: ProviderServiceShape = {
          startSession: (_threadId, input) =>
            Effect.succeed({
              provider: customAcpDriver,
              providerInstanceId: customAcpInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: input.cwd,
              threadId: input.threadId,
              resumeCursor: { schemaVersion: 1, provider: "customAcp", sessionId: "new-session" },
              createdAt: now,
              updatedAt: now,
            } satisfies ProviderSession),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: () =>
            Effect.sync(() => {
              stopped = true;
            }),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        };
        const orchestration: OrchestrationEngineShape = {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        };

        const exit = yield* Effect.exit(
          importCustomAcpExternalSession({
            providerInstanceId: customAcpInstanceId,
            projectId: ProjectId.make("project-1"),
            cwd: process.cwd(),
            sessionId: "external-session-1",
            title: "External session",
            modelSelection: { instanceId: customAcpInstanceId, model: "default" },
            runtimeMode: "full-access",
          }).pipe(
            Effect.provideService(ProviderService, providerService),
            Effect.provideService(OrchestrationEngineService, orchestration),
          ),
        );

        assert.isTrue(exit._tag === "Failure");
        assert.isTrue(stopped);
        expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.delete"]);
      }).pipe(Effect.provide(settingsLayer(makeCustomAcpSettings()))),
  );
});
