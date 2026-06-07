import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowCost,
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("formats percentages and cost", () => {
    expect(formatContextWindowPercentage(8.25)).toBe("8.3%");
    expect(formatContextWindowPercentage(81.6)).toBe("82%");
    expect(formatContextWindowPercentage(null)).toBeNull();
    expect(formatContextWindowCost(0.01234, "USD")).toBe("$0.0123");
    expect(formatContextWindowCost(12.3, "USD")).toBe("$12.30");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("retains denominator, percentages, remaining tokens, and breakdown after prompt usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 60_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 60_000,
        maxTokens: 200_000,
        totalProcessedTokens: 105_000,
        lastUsedTokens: 105_000,
        inputTokens: 50_000,
        cachedInputTokens: 40_000,
        cachedWriteTokens: 1000,
        outputTokens: 10_000,
        reasoningOutputTokens: 5_000,
        costAmount: 0.01234,
        costCurrency: "USD",
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(60_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.usedPercentage).toBe(30);
    expect(snapshot?.remainingTokens).toBe(140_000);
    expect(snapshot?.remainingPercentage).toBe(70);
    expect(snapshot?.totalProcessedTokens).toBe(105_000);
    expect(snapshot?.lastUsedTokens).toBe(105_000);
    expect(snapshot?.inputTokens).toBe(50_000);
    expect(snapshot?.cachedInputTokens).toBe(40_000);
    expect(snapshot?.cachedWriteTokens).toBe(1000);
    expect(snapshot?.outputTokens).toBe(10_000);
    expect(snapshot?.reasoningOutputTokens).toBe(5_000);
    expect(snapshot?.costAmount).toBe(0.01234);
    expect(snapshot?.costCurrency).toBe("USD");
  });

  it("derives standard ACP usage update cost objects", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 60_000,
        maxTokens: 200_000,
        cost: { amount: 0.25, currency: "USD" },
      }),
    ]);

    expect(snapshot?.costAmount).toBe(0.25);
    expect(snapshot?.costCurrency).toBe("USD");
  });
});
