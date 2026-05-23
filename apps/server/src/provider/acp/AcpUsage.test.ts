import { describe, expect, it } from "vitest";

import {
  mergeAcpTokenUsageSnapshot,
  normalizeAcpPromptUsage,
  normalizeAcpUsageUpdate,
} from "./AcpUsage.ts";

describe("AcpUsage", () => {
  it("merges prompt accounting into the latest context-window snapshot", () => {
    const contextUsage = normalizeAcpUsageUpdate({
      sessionUpdate: "usage_update",
      used: 60_000,
      size: 200_000,
      cost: { amount: 0.25, currency: "USD" },
    });
    const promptUsage = normalizeAcpPromptUsage({
      totalTokens: 105_000,
      inputTokens: 50_000,
      outputTokens: 10_000,
      cachedReadTokens: 40_000,
      cachedWriteTokens: 1_000,
      thoughtTokens: 5_000,
    });

    expect(contextUsage).toBeDefined();
    expect(promptUsage).toBeDefined();

    const merged = mergeAcpTokenUsageSnapshot(contextUsage, promptUsage!);

    expect(merged).toEqual({
      usedTokens: 60_000,
      maxTokens: 200_000,
      totalProcessedTokens: 105_000,
      lastUsedTokens: 105_000,
      inputTokens: 50_000,
      lastInputTokens: 50_000,
      cachedInputTokens: 40_000,
      lastCachedInputTokens: 40_000,
      cachedWriteTokens: 1_000,
      lastCachedWriteTokens: 1_000,
      outputTokens: 10_000,
      lastOutputTokens: 10_000,
      reasoningOutputTokens: 5_000,
      lastReasoningOutputTokens: 5_000,
      costAmount: 0.25,
      costCurrency: "USD",
    });
  });

  it("keeps prompt usage usable when no context window snapshot exists", () => {
    const promptUsage = normalizeAcpPromptUsage({
      totalTokens: 105_000,
      inputTokens: 50_000,
      outputTokens: 10_000,
    });

    expect(promptUsage).toEqual({
      usedTokens: 105_000,
      totalProcessedTokens: 105_000,
      lastUsedTokens: 105_000,
      inputTokens: 50_000,
      lastInputTokens: 50_000,
      outputTokens: 10_000,
      lastOutputTokens: 10_000,
    });
  });
});
