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

  it("keeps native context occupancy separate from cumulative processed totals", () => {
    const usage = normalizePiTokenUsage({
      tokens: {
        input: 56_383,
        cacheRead: 253_696,
        output: 1_986,
        total: 312_065,
      },
      contextUsage: {
        tokens: 37_612,
        contextWindow: 272_000,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 37_612,
      totalProcessedTokens: 312_065,
      maxTokens: 272_000,
      inputTokens: 56_383,
      cachedInputTokens: 253_696,
      outputTokens: 1_986,
    });
  });

  it("uses processed token totals as a fallback when no context usage is reported", () => {
    const usage = normalizePiTokenUsage({
      tokens: {
        input: 31_000,
        cacheRead: 9_000,
        output: 1_200,
        total: 41_200,
      },
    });

    assert.deepStrictEqual(usage, {
      usedTokens: 41_200,
      totalProcessedTokens: 41_200,
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

  it("merges accounting-only updates without replacing known context occupancy", () => {
    const state = new PiUsageState();
    state.update({
      source: "parent",
      stats: { contextUsage: { tokens: 37_612, contextWindow: 272_000 } },
    });

    assert.deepStrictEqual(
      state.update({
        source: "parent",
        stats: {
          tokens: {
            input: 56_383,
            cacheRead: 253_696,
            output: 1_986,
            total: 312_065,
          },
        },
      }),
      {
        usedTokens: 37_612,
        totalProcessedTokens: 312_065,
        maxTokens: 272_000,
        inputTokens: 56_383,
        cachedInputTokens: 253_696,
        outputTokens: 1_986,
      },
    );
  });

  it("replaces usage when the context source changes", () => {
    const state = new PiUsageState();
    state.update({
      source: "workflow",
      contextKey: "workflow-run:run-1",
      stats: {
        context: { usedTokens: 80_000, maxTokens: 272_000 },
        totals: { inputTokens: 74_000, outputTokens: 6_000 },
      },
    });

    assert.deepStrictEqual(
      state.update({
        source: "parent",
        stats: {
          tokens: { input: 603, output: 10, total: 613 },
          contextUsage: { tokens: 613, contextWindow: 272_000 },
        },
      }),
      {
        usedTokens: 613,
        totalProcessedTokens: 613,
        maxTokens: 272_000,
        inputTokens: 603,
        outputTokens: 10,
      },
    );
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

  it("allows explicit reset or compaction to report zero usage", () => {
    const state = new PiUsageState();
    state.update({
      source: "parent",
      stats: { contextUsage: { tokens: 80_000, contextWindow: 272_000 } },
    });

    assert.equal(normalizePiTokenUsage({ contextUsage: { tokens: 0 } }), undefined);
    assert.deepStrictEqual(
      state.update({
        source: "parent",
        contextChange: "reset",
        stats: { contextUsage: { tokens: 0 } },
      }),
      {
        usedTokens: 0,
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
