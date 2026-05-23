import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  type ContextWindowSnapshot,
  formatContextWindowCost,
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type UsageTone = "default" | "warning" | "danger";

type DetailRow = {
  label: string;
  value: number | null;
};

function usageTone(percentage: number | null): UsageTone {
  if (percentage === null) {
    return "default";
  }
  if (percentage >= 95) {
    return "danger";
  }
  if (percentage >= 80) {
    return "warning";
  }
  return "default";
}

function tokenLabel(value: number | null): string | null {
  return value !== null ? `${formatContextWindowTokens(value)} tokens` : null;
}

function DetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {props.title}
      </div>
      <div className="space-y-1">{props.children}</div>
    </section>
  );
}

function DetailLine(props: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-5 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="whitespace-nowrap font-medium text-foreground">{props.value}</span>
    </div>
  );
}

function TokenRows(props: { rows: ReadonlyArray<DetailRow> }) {
  const rows = props.rows.filter((row) => row.value !== null);
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground">No request breakdown reported.</div>;
  }
  return rows.map((row) => (
    <DetailLine key={row.label} label={row.label} value={tokenLabel(row.value)} />
  ));
}

export function ContextWindowMeter(props: { usage: ContextWindowSnapshot }) {
  const { usage } = props;
  const usedPercentage = formatContextWindowPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const tone = usageTone(usage.usedPercentage);
  const triggerText =
    usage.maxTokens !== null && usedPercentage !== null
      ? `${usedPercentage} ctx`
      : `${formatContextWindowTokens(usage.usedTokens)} tokens used`;
  const cost = formatContextWindowCost(usage.costAmount, usage.costCurrency);
  const hasTotalProcessed =
    usage.totalProcessedTokens !== null && usage.totalProcessedTokens > usage.usedTokens;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-full border border-transparent px-1.5 py-0.5 text-xs transition-colors hover:bg-muted/60",
              tone === "warning" && "text-amber-600 dark:text-amber-400",
              tone === "danger" && "text-destructive",
              tone === "default" && "text-muted-foreground",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex h-5 w-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span className="relative h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            <span className="whitespace-nowrap font-medium">{triggerText}</span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-72 max-w-none px-3 py-3">
        <div className="space-y-3 leading-tight">
          <DetailSection title="Context window">
            {usage.maxTokens !== null ? (
              <>
                <DetailLine
                  label="Used"
                  value={`${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(
                    usage.maxTokens,
                  )} ctx`}
                />
                {usedPercentage ? <DetailLine label="Percent used" value={usedPercentage} /> : null}
                <DetailLine label="Remaining" value={tokenLabel(usage.remainingTokens)} />
              </>
            ) : (
              <DetailLine label="Used" value={tokenLabel(usage.usedTokens)} />
            )}
            {usage.compactsAutomatically !== null ? (
              <DetailLine
                label="Auto-compact"
                value={usage.compactsAutomatically ? "Available" : "Not automatic"}
              />
            ) : null}
          </DetailSection>

          <DetailSection title="Last request">
            <TokenRows
              rows={[
                { label: "Input", value: usage.lastInputTokens },
                { label: "Output", value: usage.lastOutputTokens },
                { label: "Reasoning", value: usage.lastReasoningOutputTokens },
                { label: "Cache read", value: usage.lastCachedInputTokens },
                { label: "Cache write", value: usage.lastCachedWriteTokens },
              ]}
            />
          </DetailSection>

          {hasTotalProcessed ? (
            <DetailSection title="Total processed">
              <DetailLine label="Tokens" value={tokenLabel(usage.totalProcessedTokens)} />
            </DetailSection>
          ) : null}

          {usage.modelName !== null ||
          usage.modelProvider !== null ||
          usage.reasoningEffort !== null ? (
            <DetailSection title="Model">
              {usage.modelName !== null ? (
                <DetailLine label="Name" value={usage.modelName} />
              ) : null}
              {usage.modelProvider !== null ? (
                <DetailLine label="Provider" value={usage.modelProvider} />
              ) : null}
              {usage.reasoningEffort !== null ? (
                <DetailLine label="Effort" value={usage.reasoningEffort} />
              ) : null}
            </DetailSection>
          ) : null}

          {usage.cacheStatus !== null ? (
            <DetailSection title="Cache">
              <DetailLine label="Status" value={usage.cacheStatus} />
            </DetailSection>
          ) : null}

          {cost !== null ? (
            <DetailSection title="Cost">
              <DetailLine label="Total" value={cost} />
            </DetailSection>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
