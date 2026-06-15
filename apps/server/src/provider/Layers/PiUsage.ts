import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(root: RecordValue | undefined, key: string): RecordValue | undefined {
  if (!root) return undefined;
  const value = root[key];
  return isRecord(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function firstNonNegativeInt(...values: ReadonlyArray<unknown>): number | undefined {
  for (const value of values) {
    const normalized = nonNegativeInt(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstPositiveInt(...values: ReadonlyArray<unknown>): number | undefined {
  for (const value of values) {
    const normalized = positiveInt(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstBoolean(...values: ReadonlyArray<unknown>): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function normalizePiTokenUsage(stats: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(stats)) return undefined;

  const usage = nestedRecord(stats, "usage");
  const root = usage ?? stats;
  const tokens = nestedRecord(root, "tokens") ?? nestedRecord(root, "totals");
  const lastTokens =
    nestedRecord(root, "lastRequest") ??
    nestedRecord(root, "lastTurn") ??
    nestedRecord(root, "lastUsage");
  const contextUsage = nestedRecord(root, "contextUsage");
  const context = nestedRecord(root, "context") ?? nestedRecord(root, "contextWindow");
  const model = nestedRecord(root, "model");
  const autoCompaction = nestedRecord(root, "autoCompaction") ?? nestedRecord(root, "compaction");

  const inputTokens = firstNonNegativeInt(tokens?.input, tokens?.inputTokens);
  const outputTokens = firstNonNegativeInt(tokens?.output, tokens?.outputTokens);
  const cachedReadTokens = firstNonNegativeInt(tokens?.cacheRead, tokens?.cachedReadTokens);
  const cachedWriteTokens = firstNonNegativeInt(tokens?.cacheWrite, tokens?.cachedWriteTokens);
  const cachedInputTokens =
    cachedReadTokens !== undefined || cachedWriteTokens !== undefined
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;
  const reasoningOutputTokens = firstNonNegativeInt(
    tokens?.thought,
    tokens?.thoughtTokens,
    tokens?.reasoning,
    tokens?.reasoningTokens,
  );
  const totalProcessedTokens = firstNonNegativeInt(tokens?.total, tokens?.totalTokens);
  const contextUsedTokens = firstNonNegativeInt(
    contextUsage?.tokens,
    contextUsage?.used,
    contextUsage?.usedTokens,
    context?.used,
    context?.usedTokens,
    root.usedTokens,
    root.contextUsed,
  );
  const derivedUsed =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cachedInputTokens ?? 0) +
    (reasoningOutputTokens ?? 0);
  const usedTokens =
    contextUsedTokens ?? totalProcessedTokens ?? (derivedUsed > 0 ? derivedUsed : undefined);

  if (usedTokens === undefined || usedTokens <= 0) return undefined;

  const maxTokens = firstPositiveInt(
    contextUsage?.contextWindow,
    contextUsage?.size,
    contextUsage?.maxTokens,
    context?.size,
    context?.maxTokens,
    context?.contextWindow,
    root.contextSize,
    root.contextWindow,
    root.maxTokens,
    model?.contextWindow,
    model?.maxTokens,
  );

  const lastInputTokens = firstNonNegativeInt(lastTokens?.input, lastTokens?.inputTokens);
  const lastOutputTokens = firstNonNegativeInt(lastTokens?.output, lastTokens?.outputTokens);
  const lastCachedReadTokens = firstNonNegativeInt(
    lastTokens?.cacheRead,
    lastTokens?.cachedReadTokens,
  );
  const lastCachedWriteTokens = firstNonNegativeInt(
    lastTokens?.cacheWrite,
    lastTokens?.cachedWriteTokens,
  );
  const lastCachedInputTokens =
    lastCachedReadTokens !== undefined || lastCachedWriteTokens !== undefined
      ? (lastCachedReadTokens ?? 0) + (lastCachedWriteTokens ?? 0)
      : undefined;
  const lastReasoningOutputTokens = firstNonNegativeInt(
    lastTokens?.thought,
    lastTokens?.thoughtTokens,
    lastTokens?.reasoning,
    lastTokens?.reasoningTokens,
  );
  const lastUsedTokens =
    firstNonNegativeInt(lastTokens?.total, lastTokens?.totalTokens) ??
    (lastInputTokens !== undefined ||
    lastOutputTokens !== undefined ||
    lastCachedInputTokens !== undefined ||
    lastReasoningOutputTokens !== undefined
      ? (lastInputTokens ?? 0) +
        (lastOutputTokens ?? 0) +
        (lastCachedInputTokens ?? 0) +
        (lastReasoningOutputTokens ?? 0)
      : undefined);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(lastUsedTokens !== undefined ? { lastUsedTokens } : {}),
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    ...(lastCachedInputTokens !== undefined ? { lastCachedInputTokens } : {}),
    ...(lastOutputTokens !== undefined ? { lastOutputTokens } : {}),
    ...(lastReasoningOutputTokens !== undefined ? { lastReasoningOutputTokens } : {}),
    ...(firstBoolean(autoCompaction?.enabled, autoCompaction?.automatic, root.autoCompaction) !==
    undefined
      ? {
          compactsAutomatically: firstBoolean(
            autoCompaction?.enabled,
            autoCompaction?.automatic,
            root.autoCompaction,
          ),
        }
      : {}),
  };
}
