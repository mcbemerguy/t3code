import type { ProviderDriverKind } from "@t3tools/contracts";

export const CUSTOM_ACP_RESUME_VERSION = 2 as const;
export const LEGACY_CUSTOM_ACP_RESUME_VERSION = 1 as const;

export const PI_WORKFLOWS_LIST_METHOD = "_pi/workflows/list";
export const PI_WORKFLOWS_GET_METHOD = "_pi/workflows/get";
export const PI_WORKFLOWS_EVENTS_METHOD = "_pi/workflows/events";
export const PI_WORKFLOWS_RESUME_METHOD = "_pi/workflows/resume";
export const PI_WORKFLOWS_PAUSE_METHOD = "_pi/workflows/pause";
export const PI_WORKFLOWS_ABORT_METHOD = "_pi/workflows/abort";

const DEFAULT_WORKFLOW_METHODS = [
  PI_WORKFLOWS_LIST_METHOD,
  PI_WORKFLOWS_GET_METHOD,
  PI_WORKFLOWS_EVENTS_METHOD,
  PI_WORKFLOWS_RESUME_METHOD,
  PI_WORKFLOWS_PAUSE_METHOD,
  PI_WORKFLOWS_ABORT_METHOD,
] as const;

export interface PiWorkflowResumeRun {
  readonly runId: string;
  readonly lastSequence: number;
  readonly runDir?: string;
  readonly auditPath?: string;
  readonly status?: string;
}

export interface CustomAcpResumeTarget {
  readonly sessionId: string;
  readonly requireResumeSession: boolean;
  readonly activeWorkflowRuns: ReadonlyArray<PiWorkflowResumeRun>;
}

export interface PiWorkflowCapabilities {
  readonly listMethod?: string;
  readonly getMethod?: string;
  readonly eventsMethod?: string;
  readonly resumeMethod?: string;
  readonly pauseMethod?: string;
  readonly abortMethod?: string;
}

export interface PiWorkflowEventNotification {
  readonly runId: string;
  readonly sequence: number;
  readonly record: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function collectWorkflowRuns(raw: unknown): ReadonlyArray<PiWorkflowResumeRun> {
  if (!isRecord(raw)) return [];
  const runs = Array.isArray(raw.activeRuns)
    ? raw.activeRuns
    : Array.isArray(raw.activeWorkflowRuns)
      ? raw.activeWorkflowRuns
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
      } satisfies PiWorkflowResumeRun,
    ];
  });
}

export function parseCustomAcpResume(
  provider: ProviderDriverKind,
  raw: unknown,
): CustomAcpResumeTarget | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.provider !== provider) return undefined;
  const schemaVersion = raw.schemaVersion;
  if (
    schemaVersion !== CUSTOM_ACP_RESUME_VERSION &&
    schemaVersion !== LEGACY_CUSTOM_ACP_RESUME_VERSION
  ) {
    return undefined;
  }
  const sessionId = stringField(raw.sessionId);
  if (!sessionId) return undefined;
  return {
    sessionId,
    requireResumeSession: raw.requireSessionLoad === true,
    activeWorkflowRuns: collectWorkflowRuns(raw.workflows),
  };
}

export function makeCustomAcpResumeCursor(input: {
  readonly provider: ProviderDriverKind;
  readonly sessionId: string;
  readonly requireSessionLoad?: boolean;
  readonly activeWorkflowRuns?: ReadonlyArray<PiWorkflowResumeRun>;
}): Record<string, unknown> {
  const activeRuns = (input.activeWorkflowRuns ?? [])
    .filter((run) => run.runId.trim())
    .map((run) => ({
      runId: run.runId,
      lastSequence: run.lastSequence,
      ...(run.runDir ? { runDir: run.runDir } : {}),
      ...(run.auditPath ? { auditPath: run.auditPath } : {}),
      ...(run.status ? { status: run.status } : {}),
    }));
  return {
    schemaVersion: CUSTOM_ACP_RESUME_VERSION,
    provider: input.provider,
    sessionId: input.sessionId,
    ...(input.requireSessionLoad ? { requireSessionLoad: true } : {}),
    ...(activeRuns.length > 0 ? { workflows: { activeRuns } } : {}),
  };
}

function piAcpMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const piAcp = value.piAcp;
  return isRecord(piAcp) ? piAcp : undefined;
}

function methodFromList(methods: ReadonlyArray<string>, preferred: string): string | undefined {
  return methods.includes(preferred) ? preferred : undefined;
}

export function extractPiWorkflowCapabilities(
  initializeResult: unknown,
): PiWorkflowCapabilities | undefined {
  if (!isRecord(initializeResult)) return undefined;
  const agentCapabilities = isRecord(initializeResult.agentCapabilities)
    ? initializeResult.agentCapabilities
    : undefined;
  const meta = piAcpMeta(agentCapabilities?._meta) ?? piAcpMeta(initializeResult._meta);
  if (!meta || meta.workflows !== true) return undefined;
  const methods = Array.isArray(meta.workflowMethods)
    ? meta.workflowMethods.filter(
        (method): method is string => typeof method === "string" && method.trim().length > 0,
      )
    : [...DEFAULT_WORKFLOW_METHODS];
  const capabilities: {
    listMethod?: string;
    getMethod?: string;
    eventsMethod?: string;
    resumeMethod?: string;
    pauseMethod?: string;
    abortMethod?: string;
  } = {};
  const listMethod = methodFromList(methods, PI_WORKFLOWS_LIST_METHOD);
  const getMethod = methodFromList(methods, PI_WORKFLOWS_GET_METHOD);
  const eventsMethod =
    stringField(meta.workflowEventsMethod) ?? methodFromList(methods, PI_WORKFLOWS_EVENTS_METHOD);
  const resumeMethod = methodFromList(methods, PI_WORKFLOWS_RESUME_METHOD);
  const pauseMethod = methodFromList(methods, PI_WORKFLOWS_PAUSE_METHOD);
  const abortMethod = methodFromList(methods, PI_WORKFLOWS_ABORT_METHOD);
  if (listMethod) capabilities.listMethod = listMethod;
  if (getMethod) capabilities.getMethod = getMethod;
  if (eventsMethod) capabilities.eventsMethod = eventsMethod;
  if (resumeMethod) capabilities.resumeMethod = resumeMethod;
  if (pauseMethod) capabilities.pauseMethod = pauseMethod;
  if (abortMethod) capabilities.abortMethod = abortMethod;
  return capabilities;
}

export function parsePiWorkflowEventNotification(
  method: string,
  params: unknown,
  expectedMethod = PI_WORKFLOWS_EVENTS_METHOD,
): PiWorkflowEventNotification | undefined {
  if (method !== expectedMethod || !isRecord(params)) return undefined;
  const record = isRecord(params.event) ? params.event : undefined;
  const runId = stringField(params.runId) ?? stringField(record?.runId);
  const sequence = numberField(params.sequence) ?? numberField(record?.sequence);
  if (!record || !runId || sequence === undefined) return undefined;
  return { runId, sequence, record };
}

function piWorkflowMetaFromPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const piWorkflow = isRecord(meta?.piWorkflow) ? meta.piWorkflow : undefined;
  return piWorkflow;
}

export function workflowMetaFromRawPayload(rawPayload: unknown): { runId: string } | undefined {
  if (!isRecord(rawPayload)) return undefined;
  const piWorkflow =
    piWorkflowMetaFromPayload(rawPayload) ?? piWorkflowMetaFromPayload(rawPayload.update);
  const runId = stringField(piWorkflow?.runId);
  return runId ? { runId } : undefined;
}

export function workflowStatusFromRecord(record: Record<string, unknown>): string | undefined {
  const explicit = stringField(record.status);
  if (explicit) return explicit;
  if (record.type === "run_start") return "running";
  return undefined;
}

export function isTerminalWorkflowStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

export function workflowRunFromRecord(
  runId: string,
  sequence: number,
  record: Record<string, unknown>,
): PiWorkflowResumeRun {
  return {
    runId,
    lastSequence: sequence,
    ...(stringField(record.runDir) ? { runDir: stringField(record.runDir)! } : {}),
    ...(stringField(record.auditPath) ? { auditPath: stringField(record.auditPath)! } : {}),
    ...(workflowStatusFromRecord(record) ? { status: workflowStatusFromRecord(record)! } : {}),
  };
}
