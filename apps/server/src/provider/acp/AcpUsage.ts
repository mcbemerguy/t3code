import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

type AcpUsageUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "usage_update" }
>;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
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
  const costAmount =
    typeof update.cost?.amount === "number" && Number.isFinite(update.cost.amount)
      ? update.cost.amount
      : undefined;
  const costCurrency =
    typeof update.cost?.currency === "string" && update.cost.currency.trim().length > 0
      ? update.cost.currency.trim()
      : undefined;
  const meta = isRecord(update._meta) ? update._meta : undefined;
  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(costAmount !== undefined && costAmount >= 0 ? { costAmount } : {}),
    ...(costCurrency !== undefined ? { costCurrency } : {}),
    ...piWorkflowContextSource(meta?.piWorkflow),
  };
}

function hasRequestAccounting(usage: ThreadTokenUsageSnapshot): boolean {
  return (
    usage.totalProcessedTokens !== undefined ||
    usage.lastUsedTokens !== undefined ||
    usage.lastInputTokens !== undefined ||
    usage.lastCachedInputTokens !== undefined ||
    usage.lastCachedWriteTokens !== undefined ||
    usage.lastOutputTokens !== undefined ||
    usage.lastReasoningOutputTokens !== undefined
  );
}

function contextSourceKey(usage: ThreadTokenUsageSnapshot | undefined): string {
  return usage?.contextSourceId ?? "";
}

export function mergeAcpTokenUsageSnapshot(
  previous: ThreadTokenUsageSnapshot | undefined,
  next: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  if (!previous) {
    return next;
  }

  if (contextSourceKey(previous) !== contextSourceKey(next)) {
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

export function areAcpTokenUsageSnapshotsEqual(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const snapshotKey = key as keyof ThreadTokenUsageSnapshot;
    if (left[snapshotKey] !== right[snapshotKey]) {
      return false;
    }
  }
  return true;
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
  const cachedWriteTokens = nonNegativeInt(usage.cachedWriteTokens);
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
    ...(cachedWriteTokens !== undefined
      ? { cachedWriteTokens, lastCachedWriteTokens: cachedWriteTokens }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function piWorkflowContextSource(
  workflowValue: unknown,
  contextSessionIdValue?: unknown,
): {
  contextSourceId?: string;
  contextSourceLabel?: string;
} {
  const workflow = isRecord(workflowValue) ? workflowValue : undefined;
  const childSessionId =
    nonEmptyString(contextSessionIdValue) ?? nonEmptyString(workflow?.childSessionId);
  const stepId = nonEmptyString(workflow?.stepId);
  const runId = nonEmptyString(workflow?.runId);
  const workflowId = nonEmptyString(workflow?.workflowId);
  const contextSourceId = childSessionId
    ? `pi-workflow-child:${childSessionId}`
    : runId && stepId
      ? `pi-workflow-step:${runId}:${stepId}`
      : undefined;
  const contextSourceLabel = workflowId && stepId ? `${workflowId}/${stepId}` : stepId;
  return {
    ...(contextSourceId ? { contextSourceId } : {}),
    ...(contextSourceLabel ? { contextSourceLabel } : {}),
  };
}

function piUsageContextSource(params: Record<string, unknown>): {
  contextSourceId?: string;
  contextSourceLabel?: string;
} {
  return piWorkflowContextSource(params.workflow, params.contextSessionId);
}

export const PI_USAGE_UPDATE_METHOD = "_pi/session_usage_update";

export function normalizePiUsageTelemetry(params: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(params) || !isRecord(params.usage)) {
    return undefined;
  }
  const usage = params.usage;
  const context = isRecord(usage.context) ? usage.context : undefined;
  const totals = isRecord(usage.totals) ? usage.totals : undefined;
  const lastRequest = isRecord(usage.lastRequest) ? usage.lastRequest : undefined;
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const model = isRecord(usage.model) ? usage.model : undefined;
  const cache = isRecord(usage.cache) ? usage.cache : undefined;
  const autoCompaction = isRecord(usage.autoCompaction) ? usage.autoCompaction : undefined;

  const usedTokens = nonNegativeInt(context?.usedTokens) ?? positiveInt(totals?.totalTokens);
  if (usedTokens === undefined) {
    return undefined;
  }

  const totalProcessedTokens = positiveInt(totals?.totalTokens);
  const costAmount =
    typeof cost?.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0
      ? cost.amount
      : undefined;
  const costCurrency = nonEmptyString(cost?.currency);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    ...(positiveInt(context?.maxTokens) !== undefined
      ? { maxTokens: positiveInt(context?.maxTokens) }
      : {}),
    ...(nonNegativeInt(totals?.inputTokens) !== undefined
      ? { inputTokens: nonNegativeInt(totals?.inputTokens) }
      : {}),
    ...(nonNegativeInt(totals?.cachedReadTokens) !== undefined
      ? { cachedInputTokens: nonNegativeInt(totals?.cachedReadTokens) }
      : {}),
    ...(nonNegativeInt(totals?.cachedWriteTokens) !== undefined
      ? { cachedWriteTokens: nonNegativeInt(totals?.cachedWriteTokens) }
      : {}),
    ...(nonNegativeInt(totals?.outputTokens) !== undefined
      ? { outputTokens: nonNegativeInt(totals?.outputTokens) }
      : {}),
    ...(nonNegativeInt(totals?.reasoningTokens) !== undefined
      ? { reasoningOutputTokens: nonNegativeInt(totals?.reasoningTokens) }
      : {}),
    ...(positiveInt(lastRequest?.totalTokens) !== undefined
      ? { lastUsedTokens: positiveInt(lastRequest?.totalTokens) }
      : {}),
    ...(nonNegativeInt(lastRequest?.inputTokens) !== undefined
      ? { lastInputTokens: nonNegativeInt(lastRequest?.inputTokens) }
      : {}),
    ...(nonNegativeInt(lastRequest?.cachedReadTokens) !== undefined
      ? { lastCachedInputTokens: nonNegativeInt(lastRequest?.cachedReadTokens) }
      : {}),
    ...(nonNegativeInt(lastRequest?.cachedWriteTokens) !== undefined
      ? { lastCachedWriteTokens: nonNegativeInt(lastRequest?.cachedWriteTokens) }
      : {}),
    ...(nonNegativeInt(lastRequest?.outputTokens) !== undefined
      ? { lastOutputTokens: nonNegativeInt(lastRequest?.outputTokens) }
      : {}),
    ...(nonNegativeInt(lastRequest?.reasoningTokens) !== undefined
      ? { lastReasoningOutputTokens: nonNegativeInt(lastRequest?.reasoningTokens) }
      : {}),
    ...(booleanValue(autoCompaction?.enabled) !== undefined
      ? { compactsAutomatically: booleanValue(autoCompaction?.enabled) }
      : {}),
    ...(costAmount !== undefined ? { costAmount } : {}),
    ...(costCurrency !== undefined ? { costCurrency } : {}),
    ...(nonEmptyString(model?.name) !== undefined
      ? { modelName: nonEmptyString(model?.name) }
      : {}),
    ...(nonEmptyString(model?.provider) !== undefined
      ? { modelProvider: nonEmptyString(model?.provider) }
      : {}),
    ...(nonEmptyString(model?.effort) !== undefined
      ? { reasoningEffort: nonEmptyString(model?.effort) }
      : {}),
    ...(nonEmptyString(cache?.status) !== undefined
      ? { cacheStatus: nonEmptyString(cache?.status) }
      : {}),
    ...piUsageContextSource(params),
  };
}
