import { assert, describe, it } from "@effect/vitest";

import { arePiTokenUsageSnapshotsEqual, normalizePiTokenUsage, PiUsageState } from "./PiUsage.ts";

describe("PiUsage", () => {
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

  it("preserves known context and accounting fields across partial updates", () => {
    const state = new PiUsageState();
    assert.deepStrictEqual(
      state.update({
        source: "workflow",
        stats: {
          context: { usedTokens: 80_000, maxTokens: 272_000 },
          totals: { inputTokens: 74_000, outputTokens: 6_000 },
          lastTurn: { inputTokens: 3_000, outputTokens: 500 },
        },
      }),
      {
        usedTokens: 80_000,
        maxTokens: 272_000,
        inputTokens: 74_000,
        outputTokens: 6_000,
        lastUsedTokens: 3_500,
        lastInputTokens: 3_000,
        lastOutputTokens: 500,
      },
    );

    assert.deepStrictEqual(
      state.update({
        source: "parent",
        stats: { contextUsage: { tokens: 90_000 } },
      }),
      {
        usedTokens: 90_000,
        maxTokens: 272_000,
        inputTokens: 74_000,
        outputTokens: 6_000,
        lastUsedTokens: 3_500,
        lastInputTokens: 3_000,
        lastOutputTokens: 500,
      },
    );
  });

  it("suppresses stale smaller parent stats after richer workflow usage", () => {
    const state = new PiUsageState();
    state.update({
      source: "workflow",
      contextKey: "workflow-run:run-1",
      stats: {
        context: { usedTokens: 80_000, maxTokens: 272_000 },
        totals: { inputTokens: 74_000, outputTokens: 6_000 },
      },
    });

    assert.equal(
      state.update({
        source: "parent",
        stats: { contextUsage: { tokens: 613, contextWindow: 272_000 } },
      }),
      undefined,
    );
    assert.deepStrictEqual(state.snapshot(), {
      usedTokens: 80_000,
      maxTokens: 272_000,
      inputTokens: 74_000,
      outputTokens: 6_000,
    });
  });

  it("allows explicit compaction to lower the current usage", () => {
    const state = new PiUsageState();
    state.update({
      source: "parent",
      stats: { contextUsage: { tokens: 80_000, contextWindow: 272_000 } },
    });

    assert.deepStrictEqual(
      state.update({
        source: "parent",
        contextChange: "compaction",
        stats: { contextUsage: { tokens: 10_000 } },
      }),
      {
        usedTokens: 10_000,
        maxTokens: 272_000,
      },
    );
  });

  it("deduplicates equivalent snapshots without JSON-string keys", () => {
    const state = new PiUsageState();
    const first = state.update({
      source: "parent",
      stats: { contextUsage: { tokens: 613, contextWindow: 272_000 } },
    });
    const second = state.update({
      source: "parent",
      stats: { contextUsage: { tokens: 613, contextWindow: 272_000 } },
    });

    assert.equal(arePiTokenUsageSnapshotsEqual(first, state.snapshot()), true);
    assert.equal(second, undefined);
  });
});
