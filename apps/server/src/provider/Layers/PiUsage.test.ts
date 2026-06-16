import { assert, describe, it } from "@effect/vitest";

import { normalizePiTokenUsage } from "./PiUsage.ts";

describe("normalizePiTokenUsage", () => {
  it("normalizes the observed tiny native Pi context estimate", () => {
    const usage = normalizePiTokenUsage({
      contextUsage: {
        tokens: 613,
        contextWindow: 272_000,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 613,
      maxTokens: 272_000,
    });
  });

  it("normalizes workflow context_usage_update payloads with token totals", () => {
    const usage = normalizePiTokenUsage({
      context: {
        usedTokens: 80_000,
        maxTokens: 272_000,
      },
      totals: {
        inputTokens: 74_000,
        outputTokens: 6_000,
      },
      lastTurn: {
        inputTokens: 3_000,
        outputTokens: 500,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 80_000,
      maxTokens: 272_000,
      inputTokens: 74_000,
      outputTokens: 6_000,
      lastUsedTokens: 3_500,
      lastInputTokens: 3_000,
      lastOutputTokens: 500,
    });
  });

  it("prefers actual Pi token totals over tiny context estimates when stats disagree", () => {
    const usage = normalizePiTokenUsage({
      tokens: {
        input: 31_000,
        cacheRead: 9_000,
        output: 1_200,
        total: 41_200,
      },
      contextUsage: {
        tokens: 613,
        contextWindow: 272_000,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 41_200,
      totalProcessedTokens: 41_200,
      maxTokens: 272_000,
      inputTokens: 31_000,
      cachedInputTokens: 9_000,
      outputTokens: 1_200,
    });
  });

  it("keeps larger context usage when token totals are only partial details", () => {
    const usage = normalizePiTokenUsage({
      totals: {
        inputTokens: 20,
        outputTokens: 5,
      },
      context: {
        usedTokens: 42,
        maxTokens: 100,
      },
      autoCompaction: {
        enabled: true,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 42,
      maxTokens: 100,
      inputTokens: 20,
      outputTokens: 5,
      compactsAutomatically: true,
    });
  });

  it("does not fabricate usage from context window size alone", () => {
    const usage = normalizePiTokenUsage({
      contextUsage: {
        contextWindow: 272_000,
      },
    });

    assert.equal(usage, undefined);
  });
});
