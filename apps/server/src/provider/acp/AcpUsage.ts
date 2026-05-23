import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

type AcpUsageUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "usage_update" }
>;

function positiveInt(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeAcpUsageUpdate(
  update: AcpUsageUpdate,
): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = nonNegativeInt(update.used);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = positiveInt(update.size);
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function hasRequestAccounting(usage: ThreadTokenUsageSnapshot): boolean {
  return (
    usage.totalProcessedTokens !== undefined ||
    usage.lastUsedTokens !== undefined ||
    usage.lastInputTokens !== undefined ||
    usage.lastCachedInputTokens !== undefined ||
    usage.lastOutputTokens !== undefined ||
    usage.lastReasoningOutputTokens !== undefined
  );
}

export function mergeAcpTokenUsageSnapshot(
  previous: ThreadTokenUsageSnapshot | undefined,
  next: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  if (!previous) {
    return next;
  }

  const shouldPreserveContextWindow =
    previous.maxTokens !== undefined && next.maxTokens === undefined && hasRequestAccounting(next);

  return {
    ...previous,
    ...next,
    ...(shouldPreserveContextWindow
      ? { usedTokens: previous.usedTokens, maxTokens: previous.maxTokens }
      : {}),
  };
}

export function normalizeAcpPromptUsage(
  usage: EffectAcpSchema.PromptResponse["usage"],
): ThreadTokenUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const totalTokens = positiveInt(usage.totalTokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const inputTokens = nonNegativeInt(usage.inputTokens);
  const cachedInputTokens = nonNegativeInt(usage.cachedReadTokens);
  const outputTokens = nonNegativeInt(usage.outputTokens);
  const reasoningOutputTokens = nonNegativeInt(usage.thoughtTokens);

  return {
    usedTokens: totalTokens,
    totalProcessedTokens: totalTokens,
    lastUsedTokens: totalTokens,
    ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
  };
}
