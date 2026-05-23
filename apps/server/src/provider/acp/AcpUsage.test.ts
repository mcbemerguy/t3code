import { describe, expect, it } from "vitest";

import {
  mergeAcpTokenUsageSnapshot,
  normalizeAcpPromptUsage,
  normalizeAcpUsageUpdate,
  normalizePiUsageTelemetry,
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

  it("normalizes Pi custom usage telemetry without requiring capability metadata", () => {
    const usage = normalizePiUsageTelemetry({
      sessionId: "session-1",
      usage: {
        context: { usedTokens: 60_000, maxTokens: 200_000 },
        totals: {
          totalTokens: 106_000,
          inputTokens: 50_000,
          outputTokens: 10_000,
          reasoningTokens: 1_000,
          cachedReadTokens: 40_000,
          cachedWriteTokens: 5_000,
        },
        lastRequest: {
          totalTokens: 16_000,
          inputTokens: 10_000,
          outputTokens: 4_000,
          reasoningTokens: 1_000,
          cachedReadTokens: 500,
          cachedWriteTokens: 500,
        },
        cost: { amount: 0.42, currency: "USD" },
        model: { name: "gpt-5", provider: "openai", effort: "high" },
        cache: { status: "warm" },
        autoCompaction: { enabled: true },
      },
    });

    expect(usage).toEqual({
      usedTokens: 60_000,
      maxTokens: 200_000,
      totalProcessedTokens: 106_000,
      inputTokens: 50_000,
      outputTokens: 10_000,
      reasoningOutputTokens: 1_000,
      cachedInputTokens: 40_000,
      cachedWriteTokens: 5_000,
      lastUsedTokens: 16_000,
      lastInputTokens: 10_000,
      lastOutputTokens: 4_000,
      lastReasoningOutputTokens: 1_000,
      lastCachedInputTokens: 500,
      lastCachedWriteTokens: 500,
      compactsAutomatically: true,
      costAmount: 0.42,
      costCurrency: "USD",
      modelName: "gpt-5",
      modelProvider: "openai",
      reasoningEffort: "high",
      cacheStatus: "warm",
    });
  });

  it("ignores malformed Pi custom usage telemetry", () => {
    expect(normalizePiUsageTelemetry({ usage: { context: { usedTokens: -1 } } })).toBeUndefined();
    expect(normalizePiUsageTelemetry({ usage: null })).toBeUndefined();
  });
});
