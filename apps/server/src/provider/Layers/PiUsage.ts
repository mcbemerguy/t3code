import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

type RecordValue = Record<string, unknown>;

export type PiUsageSourceKind = "parent" | "workflow";

export type PiUsageContextChange = "compaction" | "reset";

export interface PiUsageUpdateInput {
  readonly source: PiUsageSourceKind;
  readonly stats: unknown;
  readonly contextKey?: string;
  readonly contextChange?: PiUsageContextChange;
}

type PiUsageUsedTokensSource = "context" | "processed";

interface ParsedPiTokenUsage {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly usedTokensSource: PiUsageUsedTokensSource;
  readonly hasRequestAccounting: boolean;
}

interface PiUsageUpdate extends ParsedPiTokenUsage {
  readonly source: PiUsageSourceKind;
  readonly contextKey?: string;
  readonly contextChange?: PiUsageContextChange;
}

export interface NormalizePiTokenUsageOptions {
  readonly allowZeroUsedTokens?: boolean;
}

interface PiUsageEntry {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly usedTokensSource: PiUsageUsedTokensSource;
  readonly contextKey?: string;
}

const USAGE_KEYS: ReadonlyArray<keyof ThreadTokenUsageSnapshot> = [
  "usedTokens",
  "totalProcessedTokens",
  "maxTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "lastUsedTokens",
  "lastInputTokens",
  "lastCachedInputTokens",
  "lastOutputTokens",
  "lastReasoningOutputTokens",
  "toolUses",
  "durationMs",
  "compactsAutomatically",
];

const REQUEST_ACCOUNTING_KEYS: ReadonlyArray<keyof ThreadTokenUsageSnapshot> = [
  "totalProcessedTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "lastUsedTokens",
  "lastInputTokens",
  "lastCachedInputTokens",
  "lastOutputTokens",
  "lastReasoningOutputTokens",
  "toolUses",
  "durationMs",
];

const PRESERVED_CONTEXT_RESET_KEYS: ReadonlyArray<keyof ThreadTokenUsageSnapshot> = [
  "maxTokens",
  "compactsAutomatically",
];

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

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasRequestAccounting(usage: ThreadTokenUsageSnapshot): boolean {
  return REQUEST_ACCOUNTING_KEYS.some((key) => usage[key] !== undefined);
}

function contextSourceKey(value: { readonly contextKey?: string }): string {
  return value.contextKey ?? "";
}

export function arePiTokenUsageSnapshotsEqual(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  for (const key of USAGE_KEYS) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function preserveKnownFields(
  previous: ThreadTokenUsageSnapshot,
  next: ThreadTokenUsageSnapshot,
  keys: ReadonlyArray<keyof ThreadTokenUsageSnapshot>,
): ThreadTokenUsageSnapshot {
  const merged: Record<string, unknown> = { ...next };
  for (const key of keys) {
    if (merged[key] === undefined && previous[key] !== undefined) merged[key] = previous[key];
  }
  return merged as ThreadTokenUsageSnapshot;
}

function mergeResetUsage(
  previous: ThreadTokenUsageSnapshot,
  next: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  return preserveKnownFields(previous, next, PRESERVED_CONTEXT_RESET_KEYS);
}

interface PiUsageMergeResult {
  readonly usage: ThreadTokenUsageSnapshot;
  readonly usedTokensSource: PiUsageUsedTokensSource;
}

function shouldPreserveContextUsedTokens(previous: PiUsageEntry, next: PiUsageUpdate): boolean {
  return (
    previous.usedTokensSource === "context" &&
    next.usedTokensSource === "processed" &&
    next.hasRequestAccounting
  );
}

function mergeSameContextUsage(previous: PiUsageEntry, next: PiUsageUpdate): PiUsageMergeResult {
  const preserveContextUsedTokens = shouldPreserveContextUsedTokens(previous, next);

  return {
    usage: {
      ...previous.usage,
      ...next.usage,
      ...(preserveContextUsedTokens ? { usedTokens: previous.usage.usedTokens } : {}),
    },
    usedTokensSource: preserveContextUsedTokens ? previous.usedTokensSource : next.usedTokensSource,
  };
}

function normalizePiUsageUpdate(input: PiUsageUpdateInput): PiUsageUpdate | undefined {
  const contextChange = input.contextChange ?? inferPiUsageContextChange(input.stats);
  const parsed = parsePiTokenUsage(input.stats, {
    allowZeroUsedTokens: contextChange !== undefined,
  });
  if (!parsed) return undefined;
  return {
    ...parsed,
    source: input.source,
    ...(input.contextKey ? { contextKey: input.contextKey } : {}),
    ...(contextChange ? { contextChange } : {}),
  };
}

export class PiUsageState {
  private current: PiUsageEntry | undefined;

  update(input: PiUsageUpdateInput): ThreadTokenUsageSnapshot | undefined {
    const next = normalizePiUsageUpdate(input);
    if (!next) return undefined;

    if (!this.current) {
      this.current = usageEntry(next, next.usage);
      return next.usage;
    }

    const previous = this.current;
    const current = this.merge(previous, next);
    this.current = current;
    return arePiTokenUsageSnapshotsEqual(previous.usage, current.usage) ? undefined : current.usage;
  }

  snapshot(): ThreadTokenUsageSnapshot | undefined {
    return this.current?.usage;
  }

  private merge(previous: PiUsageEntry, next: PiUsageUpdate): PiUsageEntry {
    if (contextSourceKey(previous) !== contextSourceKey(next)) return usageEntry(next, next.usage);
    if (next.contextChange) return usageEntry(next, mergeResetUsage(previous.usage, next.usage));
    const merged = mergeSameContextUsage(previous, next);
    return usageEntry(next, merged.usage, merged.usedTokensSource);
  }
}

function usageEntry(
  update: PiUsageUpdate,
  usage: ThreadTokenUsageSnapshot,
  usedTokensSource: PiUsageUsedTokensSource = update.usedTokensSource,
): PiUsageEntry {
  return {
    usage,
    usedTokensSource,
    ...(update.contextKey ? { contextKey: update.contextKey } : {}),
  };
}

export function piWorkflowUsageContextKey(record: RecordValue): string | undefined {
  const workflow = nestedRecord(record, "workflow");
  const childSessionId = firstString(record.childSessionId, workflow?.childSessionId);
  const runId = firstString(record.runId, workflow?.runId);
  const stepId = firstString(record.stepId, workflow?.stepId);
  if (childSessionId) return `workflow-child:${childSessionId}`;
  if (runId && stepId) return `workflow-step:${runId}:${stepId}`;
  if (runId) return `workflow-run:${runId}`;
  return undefined;
}

export function inferPiUsageContextChange(stats: unknown): PiUsageContextChange | undefined {
  if (!isRecord(stats)) return undefined;
  const usage = nestedRecord(stats, "usage");
  const root = usage ?? stats;
  const contextUsage = nestedRecord(root, "contextUsage");
  const context = nestedRecord(root, "context") ?? nestedRecord(root, "contextWindow");
  const autoCompaction = nestedRecord(root, "autoCompaction") ?? nestedRecord(root, "compaction");
  if (
    root.reset === true ||
    root.contextReset === true ||
    contextUsage?.reset === true ||
    context?.reset === true
  )
    return "reset";
  if (
    root.compacted === true ||
    root.contextCompacted === true ||
    autoCompaction?.completed === true ||
    autoCompaction?.compacted === true ||
    autoCompaction?.event === "completed"
  )
    return "compaction";
  return undefined;
}

export function normalizePiTokenUsage(
  stats: unknown,
  options?: NormalizePiTokenUsageOptions,
): ThreadTokenUsageSnapshot | undefined {
  return parsePiTokenUsage(stats, options)?.usage;
}

function parsePiTokenUsage(
  stats: unknown,
  options?: NormalizePiTokenUsageOptions,
): ParsedPiTokenUsage | undefined {
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
  const processedUsedTokens = totalProcessedTokens ?? (derivedUsed > 0 ? derivedUsed : undefined);
  const usedTokens = contextUsedTokens ?? processedUsedTokens;

  if (usedTokens === undefined || (!options?.allowZeroUsedTokens && usedTokens <= 0))
    return undefined;

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
  const compactsAutomatically = firstBoolean(
    autoCompaction?.enabled,
    autoCompaction?.automatic,
    root.autoCompaction,
  );

  const normalizedUsage: ThreadTokenUsageSnapshot = {
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
    ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
  };

  return {
    usage: normalizedUsage,
    usedTokensSource: contextUsedTokens !== undefined ? "context" : "processed",
    hasRequestAccounting: hasRequestAccounting(normalizedUsage),
  };
}
