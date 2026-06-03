import type {
  ProviderDriverKind,
  ProviderWorkflowControlAction,
  ProviderWorkflowRunCursor,
  ProviderWorkflowRunStatus,
} from "@t3tools/contracts";

export const CUSTOM_ACP_RESUME_VERSION = 2 as const;
export const LEGACY_CUSTOM_ACP_RESUME_VERSION = 1 as const;

export const PI_WORKFLOWS_LIST_METHOD = "_pi/workflows/list";
export const PI_WORKFLOWS_GET_METHOD = "_pi/workflows/get";
export const PI_WORKFLOWS_EVENTS_METHOD = "_pi/workflows/events";
export const PI_WORKFLOWS_RESUME_METHOD = "_pi/workflows/resume";
export const PI_WORKFLOWS_INTERRUPT_METHOD = "_pi/workflows/interrupt";
export const PI_WORKFLOWS_PAUSE_METHOD = "_pi/workflows/pause";
export const PI_WORKFLOWS_ABORT_METHOD = "_pi/workflows/abort";

const DEFAULT_WORKFLOW_METHODS = [
  PI_WORKFLOWS_LIST_METHOD,
  PI_WORKFLOWS_GET_METHOD,
  PI_WORKFLOWS_EVENTS_METHOD,
  PI_WORKFLOWS_RESUME_METHOD,
  PI_WORKFLOWS_INTERRUPT_METHOD,
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
  readonly interruptMethod?: string;
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
    .map((run) => {
      const activeRun: Record<string, unknown> = {
        runId: run.runId,
        lastSequence: run.lastSequence,
      };
      if (run.runDir) activeRun.runDir = run.runDir;
      if (run.auditPath) activeRun.auditPath = run.auditPath;
      if (run.status) activeRun.status = run.status;
      return activeRun;
    });
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
    interruptMethod?: string;
    pauseMethod?: string;
    abortMethod?: string;
  } = {};
  const listMethod = methodFromList(methods, PI_WORKFLOWS_LIST_METHOD);
  const getMethod = methodFromList(methods, PI_WORKFLOWS_GET_METHOD);
  const eventsMethod =
    stringField(meta.workflowEventsMethod) ?? methodFromList(methods, PI_WORKFLOWS_EVENTS_METHOD);
  const resumeMethod = methodFromList(methods, PI_WORKFLOWS_RESUME_METHOD);
  const interruptMethod = methodFromList(methods, PI_WORKFLOWS_INTERRUPT_METHOD);
  const pauseMethod = methodFromList(methods, PI_WORKFLOWS_PAUSE_METHOD);
  const abortMethod = methodFromList(methods, PI_WORKFLOWS_ABORT_METHOD);
  if (listMethod) capabilities.listMethod = listMethod;
  if (getMethod) capabilities.getMethod = getMethod;
  if (eventsMethod) capabilities.eventsMethod = eventsMethod;
  if (resumeMethod) capabilities.resumeMethod = resumeMethod;
  if (interruptMethod) capabilities.interruptMethod = interruptMethod;
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

export function workflowActionsForStatus(
  status: string | undefined,
  capabilities: PiWorkflowCapabilities | undefined,
): ReadonlyArray<ProviderWorkflowControlAction> {
  if (isTerminalWorkflowStatus(status)) return [];
  const actions: ProviderWorkflowControlAction[] = [];
  if (status === "interrupted" || status === "paused" || status === "recovering") {
    if (capabilities?.resumeMethod) actions.push("continue");
  }
  if (status === "running") {
    if (capabilities?.interruptMethod) actions.push("interrupt");
    else if (capabilities?.pauseMethod) actions.push("pause");
  }
  if (capabilities?.abortMethod) actions.push("abort");
  return actions;
}

export function workflowCursorFromResumeRun(input: {
  readonly run: PiWorkflowResumeRun;
  readonly capabilities: PiWorkflowCapabilities | undefined;
  readonly updatedAt: string;
}): ProviderWorkflowRunCursor | undefined {
  const status = stringField(input.run.status) ?? "running";
  return workflowCursorFromFields({
    runId: input.run.runId,
    status,
    lastSequence: input.run.lastSequence,
    ...(input.run.runDir ? { runDir: input.run.runDir } : {}),
    ...(input.run.auditPath ? { auditPath: input.run.auditPath } : {}),
    capabilities: input.capabilities,
    updatedAt: input.updatedAt,
  });
}

export function workflowCursorFromControlResponse(input: {
  readonly runId: string;
  readonly lastSequence: number;
  readonly raw: unknown;
  readonly capabilities: PiWorkflowCapabilities | undefined;
  readonly updatedAt: string;
}): ProviderWorkflowRunCursor | undefined {
  const rawRun = isRecord(input.raw) && isRecord(input.raw.run) ? input.raw.run : undefined;
  const runDir = stringField(rawRun?.runDir);
  const auditPath = stringField(rawRun?.auditPath);
  return workflowCursorFromFields({
    runId: stringField(rawRun?.runId) ?? stringField(rawRun?.id) ?? input.runId,
    status: stringField(rawRun?.status) ?? "running",
    lastSequence: numberField(rawRun?.lastSequence) ?? input.lastSequence,
    ...(runDir ? { runDir } : {}),
    ...(auditPath ? { auditPath } : {}),
    capabilities: input.capabilities,
    updatedAt: input.updatedAt,
  });
}

function workflowCursorFromFields(input: {
  readonly runId: string;
  readonly status: string;
  readonly lastSequence: number;
  readonly runDir?: string;
  readonly auditPath?: string;
  readonly capabilities: PiWorkflowCapabilities | undefined;
  readonly updatedAt: string;
}): ProviderWorkflowRunCursor | undefined {
  const runId = stringField(input.runId);
  if (!runId) return undefined;
  const status = normalizeWorkflowStatus(input.status);
  return {
    runId,
    status,
    terminal: isTerminalWorkflowStatus(status),
    lastSequence: input.lastSequence,
    ...(input.runDir ? { runDir: input.runDir } : {}),
    ...(input.auditPath ? { auditPath: input.auditPath } : {}),
    actions: workflowActionsForStatus(status, input.capabilities),
    updatedAt: input.updatedAt,
  };
}

function normalizeWorkflowStatus(status: string): ProviderWorkflowRunStatus {
  switch (status) {
    case "paused":
    case "interrupted":
    case "recovering":
    case "completed":
    case "failed":
    case "aborted":
      return status;
    case "running":
    default:
      return "running";
  }
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
