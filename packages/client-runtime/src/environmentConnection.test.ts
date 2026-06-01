import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection } from "./environmentConnection.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";

const environmentId = "environment-local" as EnvironmentId;

const shellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-01T00:00:00.000Z",
} as OrchestrationShellSnapshot;

async function sleep(ms: number): Promise<void> {
  await Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}

describe("createEnvironmentConnection", () => {
  it("keeps existing bootstrap waiters attached across shell resubscribe resets", async () => {
    const shellSubscription: {
      listener: ((item: OrchestrationShellStreamItem) => void) | null;
      onResubscribe?: () => void;
    } = { listener: null };

    const client = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      orchestration: {
        subscribeShell: vi.fn((listener, options) => {
          shellSubscription.listener = listener;
          shellSubscription.onResubscribe = options?.onResubscribe;
          return () => undefined;
        }),
      },
    } as unknown as WsRpcClient;

    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        id: "local",
        label: "Local",
        source: "manual",
        environmentId,
        target: {
          httpBaseUrl: "http://localhost:3020",
          wsBaseUrl: "ws://localhost:3020",
        },
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    let bootstrapped = false;
    const bootstrap = connection.ensureBootstrapped().then(() => {
      bootstrapped = true;
    });

    shellSubscription.onResubscribe?.();
    await sleep(10);

    expect(bootstrapped).toBe(false);
    expect(shellSubscription.listener).not.toBeNull();

    const listener = shellSubscription.listener;
    if (!listener) {
      throw new Error("Expected shell subscription listener to be registered.");
    }
    listener({ kind: "snapshot", snapshot: shellSnapshot });

    await expect(bootstrap).resolves.toBeUndefined();
    expect(bootstrapped).toBe(true);
  });
});
