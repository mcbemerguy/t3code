import { assert, describe, it } from "@effect/vitest";

import { normalizePiTokenUsage } from "./PiUsage.ts";

describe("normalizePiTokenUsage", () => {
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
