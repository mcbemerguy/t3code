// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkPiProviderStatus } from "./PiProvider.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockPiRpcPath = path.join(__dirname, "fixtures/mock-pi-rpc.mjs");

async function makeMockPiWrapper(extraEnv: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-provider-mock-"));
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

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("discovers Pi RPC models for the provider picker", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.installed).toBe(true);
      expect(provider.status).toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["mock/model-a"]);
      expect(provider.models[0]?.name).toBe("Model A");
      expect(provider.message).toContain("Native Pi chat sessions are available");
    }),
  );

  it.effect("maps Pi RPC commands into slash commands and skills", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.slashCommands).toEqual([
        {
          name: "compact",
          description: "Manually compact the Pi session context",
          input: { hint: "optional instructions" },
        },
        { name: "workflow:list", description: "List workflow runs" },
        { name: "commit-message", description: "Draft a commit message" },
      ]);
      expect(provider.skills).toEqual([
        {
          name: "browser-tools",
          description: "Interactive browser automation",
          path: "/mock/pi/skills/browser-tools/SKILL.md",
          scope: "user",
          enabled: true,
          displayName: "browser-tools",
          shortDescription: "Interactive browser automation",
        },
      ]);
    }),
  );

  it.effect("falls back to Pi default when model discovery returns no models", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_EMPTY_MODELS: "1" }),
      );
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.status).toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      expect(provider.message).toContain("Model discovery fell back to Pi default");
    }),
  );

  it.effect("does not report ready when Pi RPC model discovery fails", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_FAIL_COMMAND: "get_available_models" }),
      );
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.status).not.toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      expect(provider.message).toContain("mock failure: get_available_models");
    }),
  );

  it.effect("does not report ready when Pi RPC model discovery times out", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_IGNORE_COMMAND: "get_available_models" }),
      );
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.status).not.toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      expect(provider.message).toContain("get_available_models timed out");
    }),
  );

  it.effect("does not report ready when Pi RPC startup fails after version succeeds", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_EXIT_ON_START: "1" }),
      );
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.status).not.toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      expect(provider.message).toContain("mock startup failure");
    }),
  );

  it.effect("keeps the provider available when Pi RPC command discovery fails", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ MOCK_PI_RPC_FAIL_COMMAND: "get_commands" }),
      );
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath });

      expect(provider.status).toBe("ready");
      expect(provider.models.map((model) => model.slug)).toEqual(["mock/model-a"]);
      expect(provider.slashCommands).toEqual([
        {
          name: "compact",
          description: "Manually compact the Pi session context",
          input: { hint: "optional instructions" },
        },
      ]);
      expect(provider.skills).toEqual([]);
      expect(provider.message).toContain("Command discovery failed: mock failure: get_commands");
    }),
  );
});
