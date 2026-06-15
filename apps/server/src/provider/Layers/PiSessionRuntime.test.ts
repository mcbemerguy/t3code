// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  PiRpcLifecycleError,
  PiRpcTimeoutError,
  buildPiRpcSpawnArgs,
  buildPiRpcSpawnEnv,
  makePiSessionRuntime,
  parsePiRpcStdoutLine,
  windowsProcessTreeKillCommand,
  type PiSessionRuntimeError,
  type PiSessionRuntimeShape,
} from "./PiSessionRuntime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockPiRpcPath = path.join(__dirname, "fixtures/mock-pi-rpc.mjs");

async function makeMockPiWrapper(extraEnv: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-rpc-mock-"));
  const isWindows = process.platform === "win32";
  const wrapperPath = path.join(dir, isWindows ? "fake-pi.cmd" : "fake-pi.sh");

  if (isWindows) {
    const envLines = Object.entries(extraEnv)
      .map(([key, value]) => `set "${key}=${value}"`)
      .join("\r\n");
    await writeFile(
      wrapperPath,
      `@echo off\r\n${envLines}\r\n"${process.execPath}" "${mockPiRpcPath}" %*\r\n`,
      "utf8",
    );
    return wrapperPath;
  }

  const envExports = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPiRpcPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonFileEventually(filePath: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      await sleep(10);
    }
  }
  throw lastError;
}

function makeRuntime(extraEnv: Record<string, string> = {}) {
  return Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() => makeMockPiWrapper(extraEnv));
    return yield* makePiSessionRuntime({
      threadId: ThreadId.make("thread-pi-runtime"),
      binaryPath,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      timeouts: { request: 100, abort: 100, workflowControl: 100 },
    });
  });
}

function withStartedRuntime<T>(
  extraEnv: Record<string, string>,
  use: (runtime: PiSessionRuntimeShape) => Effect.Effect<T, PiSessionRuntimeError>,
) {
  return Effect.gen(function* () {
    const runtime = yield* makeRuntime(extraEnv);
    yield* runtime.start();
    return yield* use(runtime).pipe(Effect.ensuring(runtime.close));
  }).pipe(Effect.orDie);
}

describe("Pi RPC protocol helpers", () => {
  it("parses NDJSON lines and strips non-JSON prelude ANSI", () => {
    assert.deepStrictEqual(parsePiRpcStdoutLine(""), null);
    assert.deepStrictEqual(
      parsePiRpcStdoutLine('{"type":"response","command":"get_state","success":true}'),
      {
        kind: "json",
        message: { type: "response", command: "get_state", success: true },
      },
    );
    assert.deepStrictEqual(parsePiRpcStdoutLine("\u001b[32mContext loaded\u001b[0m"), {
      kind: "prelude",
      line: "Context loaded",
    });
  });

  it("builds spawn args/env and exposes Windows tree-kill command shape", () => {
    assert.deepStrictEqual(buildPiRpcSpawnArgs({ sessionFile: "C:/tmp/pi-session.json" }), [
      "--mode",
      "rpc",
      "--no-themes",
      "--session",
      "C:/tmp/pi-session.json",
    ]);

    const env = buildPiRpcSpawnEnv({ PI_DELEGATED_TOOL_CAP: "ask_user_questions,edit, shell" });
    assert.equal(env.PI_ACP, "1");
    assert.equal(env.PI_ACP_RPC, "1");
    assert.equal(env.PI_DELEGATED_TOOL_CAP, "edit,shell");

    assert.deepStrictEqual(windowsProcessTreeKillCommand(1234), {
      command: "taskkill",
      args: ["/PID", "1234", "/T", "/F"],
      options: { stdio: "ignore", windowsHide: true },
    });
  });
});

describe("PiSessionRuntime", () => {
  it.effect("spawns a mock Pi RPC process, correlates responses, and preserves raw messages", () =>
    withStartedRuntime(
      {
        MOCK_PI_RPC_PRELUDE: "Mock Pi ready",
        MOCK_PI_RPC_NO_ID_COMMAND: "get_session_stats",
      },
      (runtime) =>
        Effect.gen(function* () {
          const session = yield* runtime.getSession;
          assert.equal(session.status, "ready");
          assert.equal(session.model, "mock/model");
          assert.deepStrictEqual(session.resumeCursor, {
            sessionFile: "/tmp/mock-pi-session.json",
          });

          const models = yield* runtime.getAvailableModels;
          assert.deepStrictEqual(models, {
            providers: [{ id: "mock", models: [{ id: "model-a" }] }],
          });

          const promptResult = yield* runtime.prompt({ message: "hello" });
          assert.equal(promptResult.turnId, "turn-mock");
          yield* runtime.setModel("mock", "model-b");
          assert.equal((yield* runtime.getSession).model, "mock/model-b");
          yield* runtime.abort();
          assert.deepStrictEqual(yield* runtime.getSessionStats, {
            tokens: { input: 10, output: 2 },
          });

          assert.deepStrictEqual(yield* runtime.consumePreludeLines, ["Mock Pi ready"]);
          const raw = yield* runtime.events.pipe(Stream.take(6), Stream.runCollect);
          assert.equal(
            raw.some(
              (message) => message.kind === "event" && message.payload.type === "assistant_delta",
            ),
            true,
          );
          assert.equal(
            raw.some((message) => message.kind === "response" && message.correlated),
            true,
          );
        }),
    ),
  );

  it.effect("times out pending requests with process diagnostics", () =>
    withStartedRuntime({ MOCK_PI_RPC_IGNORE_COMMAND: "get_session_stats" }, (runtime) =>
      Effect.gen(function* () {
        const error = yield* runtime.getSessionStats.pipe(Effect.flip, Effect.orDie);
        assert.equal(error instanceof PiRpcTimeoutError, true);
        if (error instanceof PiRpcTimeoutError) {
          assert.equal(error.input.command, "get_session_stats");
          assert.equal(error.message.includes("process status:"), true);
        }
      }),
    ),
  );

  it.effect("does not correlate late responses with stale ids to newer requests", () =>
    withStartedRuntime({ MOCK_PI_RPC_STALE_ID_COMMAND: "get_session_stats" }, (runtime) =>
      Effect.gen(function* () {
        const error = yield* runtime.getSessionStats.pipe(Effect.flip, Effect.orDie);
        assert.equal(error instanceof PiRpcTimeoutError, true);

        const stats = yield* runtime.getSessionStats;
        assert.deepStrictEqual(stats, { fresh: true });
      }),
    ),
  );

  it.effect("sends extension UI responses without replacing the Pi UI request id", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "pi-rpc-ui-")));
      const responseFile = path.join(dir, "extension-ui.json");
      const runtime = yield* makeRuntime({
        MOCK_PI_RPC_EXTENSION_UI_FILE: responseFile,
        MOCK_PI_RPC_EXTENSION_UI_NO_RESPONSE: "1",
      });

      yield* runtime.start();
      yield* Effect.gen(function* () {
        yield* runtime.respondExtensionUi({ id: "ui-request-123", value: "answer" });
        const request = (yield* Effect.promise(() =>
          readJsonFileEventually(responseFile),
        )) as Record<string, unknown>;
        assert.deepStrictEqual(request, {
          type: "extension_ui_response",
          id: "ui-request-123",
          value: "answer",
        });
      }).pipe(Effect.ensuring(runtime.close));
    }).pipe(Effect.orDie),
  );

  it.effect("reports stderr diagnostics when the process exits during startup", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ MOCK_PI_RPC_EXIT_ON_START: "1" });
      const error = yield* runtime.start().pipe(Effect.flip, Effect.ensuring(runtime.close));
      assert.equal(error instanceof PiRpcLifecycleError, true);
      if (error instanceof PiRpcLifecycleError) {
        assert.equal(error.message.includes("mock startup failure"), true);
        assert.equal(error.message.includes("process status:"), true);
      }
    }).pipe(Effect.orDie),
  );

  it.effect("passes resume sessionFile through --session args", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "pi-rpc-args-")));
      const argsFile = path.join(dir, "args.json");
      const sessionFile = path.join(dir, "restored-session.json");
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_ARGS_FILE: argsFile }),
      );
      const runtime = yield* makePiSessionRuntime({
        threadId: ThreadId.make("thread-pi-restore"),
        binaryPath,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { sessionFile },
        timeouts: { request: 100 },
      });

      yield* runtime.start();
      yield* Effect.gen(function* () {
        const args = JSON.parse(
          yield* Effect.promise(() => readFile(argsFile, "utf8")),
        ) as ReadonlyArray<string>;
        assert.deepStrictEqual(args, ["--mode", "rpc", "--no-themes", "--session", sessionFile]);
      }).pipe(Effect.ensuring(runtime.close));
    }).pipe(Effect.orDie),
  );
});
