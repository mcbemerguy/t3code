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

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null;
}) {
  const { usage, providerDisplayName } = props;
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
  const usageColor = tone === "danger" ? "var(--color-red-500)" : "var(--color-blue-500)";
  const compactActor = providerDisplayName ?? "This agent";

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
              "group inline-flex items-center gap-1.5 rounded-full border border-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:bg-muted/60 data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
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
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
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
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(normalizedPercentage)}
                  aria-label="Context window usage"
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
                  />
                </div>
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
            {usage.compactsAutomatically ? (
              <div className="pt-0.5 text-pretty text-[11px] text-muted-foreground">
                {compactActor} automatically compacts its context when needed.
              </div>
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

          {usage.contextSourceId !== null || usage.contextSourceLabel !== null ? (
            <DetailSection title="Source">
              {usage.contextSourceLabel !== null ? (
                <DetailLine label="Label" value={usage.contextSourceLabel} />
              ) : null}
              {usage.contextSourceId !== null ? (
                <DetailLine label="ID" value={usage.contextSourceId} />
              ) : null}
            </DetailSection>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
