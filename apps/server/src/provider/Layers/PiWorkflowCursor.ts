import { ProviderDriverKind, ProviderInstanceId, type ProviderSession } from "@t3tools/contracts";

import type { PiResumeCursor, PiWorkflowRunCursor } from "./PiSessionRuntime.ts";

export const PI_RESUME_CURSOR_VERSION = 1;
const PROVIDER = ProviderDriverKind.make("pi");
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed", "aborted", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isTerminalWorkflowStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_WORKFLOW_STATUSES.has(status.toLowerCase());
}

export function parsePiWorkflowRunCursors(raw: unknown): ReadonlyArray<PiWorkflowRunCursor> {
  if (!isRecord(raw)) return [];
  const source = isRecord(raw.workflows) ? raw.workflows : raw;
  const runs = Array.isArray(source.activeRuns)
    ? source.activeRuns
    : Array.isArray(source.runs)
      ? source.runs
      : Array.isArray(source.activeWorkflowRuns)
        ? source.activeWorkflowRuns
        : [];
  return runs.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const runId = stringField(entry.runId) ?? stringField(entry.id);
    if (!runId) return [];
    return [
      {
        runId,
        lastSequence: numberField(entry.lastSequence) ?? 0,
        ...(stringField(entry.runDir) ? { runDir: stringField(entry.runDir)! } : {}),
        ...(stringField(entry.auditPath) ? { auditPath: stringField(entry.auditPath)! } : {}),
        ...(stringField(entry.status) ? { status: stringField(entry.status)! } : {}),
      },
    ];
  });
}

export function parsePiResumeCursor(
  raw: unknown,
  options?: { readonly expectedProviderInstanceId?: ProviderInstanceId },
): PiResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionFile = stringField(raw.sessionFile) ?? stringField(raw.sessionPath);
  if (!sessionFile) return undefined;
  if (raw.provider !== undefined && raw.provider !== PROVIDER) return undefined;
  const providerInstanceId = stringField(raw.providerInstanceId);
  if (
    providerInstanceId !== undefined &&
    options?.expectedProviderInstanceId !== undefined &&
    providerInstanceId !== options.expectedProviderInstanceId
  ) {
    return undefined;
  }
  const activeRuns = parsePiWorkflowRunCursors(raw).filter(
    (run) => !isTerminalWorkflowStatus(run.status),
  );
  return makePiResumeCursor({
    sessionFile,
    activeWorkflowRuns: activeRuns,
    ...(providerInstanceId
      ? { providerInstanceId: ProviderInstanceId.make(providerInstanceId) }
      : {}),
  });
}

export function makePiResumeCursor(input: {
  readonly sessionFile: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly activeWorkflowRuns?: ReadonlyArray<PiWorkflowRunCursor>;
}): PiResumeCursor {
  const activeRuns = (input.activeWorkflowRuns ?? [])
    .filter((run) => run.runId.trim() && !isTerminalWorkflowStatus(run.status))
    .map((run) => ({
      runId: run.runId,
      lastSequence: Math.max(0, Math.trunc(run.lastSequence)),
      ...(run.runDir ? { runDir: run.runDir } : {}),
      ...(run.auditPath ? { auditPath: run.auditPath } : {}),
      ...(run.status ? { status: run.status } : {}),
    }));
  return {
    schemaVersion: PI_RESUME_CURSOR_VERSION,
    provider: "pi",
    sessionFile: input.sessionFile,
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    ...(activeRuns.length > 0 ? { workflows: { activeRuns } } : {}),
  };
}

export function mergeWorkflowRunCursor(
  previous: PiWorkflowRunCursor | undefined,
  next: PiWorkflowRunCursor,
): PiWorkflowRunCursor {
  return {
    runId: next.runId,
    lastSequence: Math.max(previous?.lastSequence ?? 0, next.lastSequence),
    ...((next.runDir ?? previous?.runDir) ? { runDir: next.runDir ?? previous?.runDir } : {}),
    ...((next.auditPath ?? previous?.auditPath)
      ? { auditPath: next.auditPath ?? previous?.auditPath }
      : {}),
    ...((next.status ?? previous?.status) ? { status: next.status ?? previous?.status } : {}),
  };
}

export function sessionFileFromProviderSession(session: ProviderSession): string | undefined {
  const cursor = parsePiResumeCursor(session.resumeCursor);
  return cursor?.sessionFile;
}
