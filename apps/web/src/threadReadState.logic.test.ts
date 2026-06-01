import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { deriveThreadVisitedSeedAt } from "./threadReadState.logic";
import type { Thread } from "./types";

type ThreadVisitedSeedInput = Parameters<typeof deriveThreadVisitedSeedAt>[0];

function makeLatestTurn(
  overrides: Partial<NonNullable<Thread["latestTurn"]>> = {},
): NonNullable<Thread["latestTurn"]> {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:02:00.000Z",
    startedAt: "2026-03-09T10:03:00.000Z",
    completedAt: "2026-03-09T10:04:00.000Z",
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<NonNullable<Thread["session"]>> = {},
): NonNullable<Thread["session"]> {
  return {
    provider: ProviderDriverKind.make("codex"),
    status: "ready",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:05:00.000Z",
    orchestrationStatus: "ready",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadVisitedSeedInput> = {}): ThreadVisitedSeedInput {
  return {
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:01:00.000Z",
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("deriveThreadVisitedSeedAt", () => {
  it("uses the latest valid lifecycle, latest-turn, or session timestamp", () => {
    expect(
      deriveThreadVisitedSeedAt(
        makeThread({
          updatedAt: "2026-03-09T10:01:00.000Z",
          latestTurn: makeLatestTurn({
            completedAt: "2026-03-09T10:06:00.000+00:00",
          }),
          session: makeSession({
            updatedAt: "2026-03-09T10:05:00.000Z",
          }),
        }),
      ),
    ).toBe("2026-03-09T10:06:00.000+00:00");
  });

  it("seeds from a newer latest turn when the thread shell timestamp is stale", () => {
    expect(
      deriveThreadVisitedSeedAt(
        makeThread({
          updatedAt: "2026-05-29T17:57:04.125Z",
          latestTurn: makeLatestTurn({
            requestedAt: "2026-05-29T17:58:00.000Z",
            startedAt: "2026-05-29T17:58:05.000Z",
            completedAt: "2026-05-29T18:03:45.744Z",
          }),
        }),
      ),
    ).toBe("2026-05-29T18:03:45.744Z");
  });

  it("ignores missing or invalid candidates", () => {
    expect(
      deriveThreadVisitedSeedAt(
        makeThread({
          createdAt: "not-a-date",
          updatedAt: "",
          latestTurn: makeLatestTurn({
            requestedAt: "also-invalid",
            startedAt: null,
            completedAt: null,
          }),
          session: makeSession({
            updatedAt: "2026-03-09T10:05:00.000Z",
          }),
        }),
      ),
    ).toBe("2026-03-09T10:05:00.000Z");
  });

  it("returns undefined when no timestamp is valid", () => {
    expect(
      deriveThreadVisitedSeedAt(
        makeThread({
          createdAt: "not-a-date",
          updatedAt: "also-invalid",
          latestTurn: null,
          session: null,
        }),
      ),
    ).toBeUndefined();
  });
});
