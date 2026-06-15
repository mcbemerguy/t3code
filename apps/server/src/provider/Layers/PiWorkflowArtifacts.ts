// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { PiWorkflowRunCursor } from "./PiSessionRuntime.ts";
import { isTerminalWorkflowStatus } from "./PiWorkflowCursor.ts";

export type PiWorkflowRunStatus =
  | "running"
  | "paused"
  | "interrupted"
  | "recovering"
  | "completed"
  | "failed"
  | "aborted";

export interface PiWorkflowRunRecord extends Record<string, unknown> {
  readonly id: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly status: PiWorkflowRunStatus;
  readonly workflowId?: string;
  readonly parentSessionFile?: string;
  readonly auditPath?: string;
}

export interface PiWorkflowReplayRecord {
  readonly record: Record<string, unknown>;
  readonly sequence?: number;
  readonly source: {
    readonly sourceKey: string;
    readonly line: number;
  };
}

export interface PiWorkflowReplayBatch {
  readonly records: ReadonlyArray<PiWorkflowReplayRecord>;
  readonly nextTail: {
    readonly offset: number;
    readonly line: number;
  };
}

export function defaultPiWorkflowRunsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "workflow-runs");
}

export function parseWorkflowCommandPrompt(message: string):
  | {
      readonly workflowId: string;
      readonly commandName: string;
      readonly initialTaskMessage?: string;
    }
  | undefined {
  const match = /^\s*\/workflow:([^\s]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match) return undefined;
  const workflowId = match[1]?.trim();
  if (!workflowId || ["control", "pause", "resume", "abort", "interrupt"].includes(workflowId))
    return undefined;
  const rawArgs = (match[2] ?? "").trim();
  const initialTaskMessage = rawArgs.startsWith("--") ? rawArgs.slice(2).trimStart() : rawArgs;
  return {
    workflowId,
    commandName: `workflow:${workflowId}`,
    ...(initialTaskMessage ? { initialTaskMessage } : {}),
  };
}

export function parseWorkflowControlPrompt(
  message: string,
): { readonly action: "pause" | "resume" | "abort"; readonly target?: string } | undefined {
  const match = /^\s*\/workflow:(pause|resume|abort)(?:\s+([^\s]+))?/i.exec(message);
  if (!match) return undefined;
  const action = match[1]?.toLowerCase() as "pause" | "resume" | "abort" | undefined;
  if (!action) return undefined;
  return { action, ...(match[2]?.trim() ? { target: match[2].trim() } : {}) };
}

export function listPiWorkflowRuns(
  root = defaultPiWorkflowRunsDir(),
): ReadonlyArray<PiWorkflowRunRecord> {
  let entries: ReadonlyArray<string> = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const run = readPiWorkflowRun(join(root, entry));
    return run ? [run] : [];
  });
}

export function readPiWorkflowRun(
  target: string,
  root = defaultPiWorkflowRunsDir(),
): PiWorkflowRunRecord | undefined {
  const runDir = resolveWorkflowRunDir(target, root);
  const raw = readJsonObject(join(runDir, "run.json"));
  if (!raw) return undefined;
  const id = stringField(raw.id) ?? basename(runDir);
  const cwd = stringField(raw.cwd);
  const status = stringField(raw.status) as PiWorkflowRunStatus | undefined;
  if (!cwd || !status) return undefined;
  return {
    ...raw,
    id,
    cwd,
    status,
    runDir: stringField(raw.runDir) ?? runDir,
    ...(stringField(raw.workflowId) ? { workflowId: stringField(raw.workflowId)! } : {}),
    ...(stringField(raw.parentSessionFile)
      ? { parentSessionFile: stringField(raw.parentSessionFile)! }
      : {}),
    ...(stringField(raw.auditPath) ? { auditPath: stringField(raw.auditPath)! } : {}),
  };
}

export function replayPiWorkflowEvents(
  run: PiWorkflowRunCursor,
  options: {
    readonly workflowRunsDir?: string;
    readonly includeTerminalFallback?: boolean;
    readonly startOffset?: number;
    readonly startLine?: number;
  } = {},
): PiWorkflowReplayBatch {
  const root = options.workflowRunsDir ?? defaultPiWorkflowRunsDir();
  const runDir = resolveWorkflowRunDir(run.runDir ?? run.runId, root);
  const eventsPath = join(runDir, "events.jsonl");
  const sourceKey = `events-jsonl:${eventsPath}`;
  const records: Array<PiWorkflowReplayRecord> = [];
  let sawRunEnd = false;
  let maxSequence = 0;
  const read = readWorkflowEventsRange(eventsPath, options.startOffset ?? 0);
  let nextOffset = read.nextOffset;
  let nextLine = options.startLine ?? 1;
  if (read.text) {
    const lines = read.text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index]?.trim();
      const line = nextLine++;
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
      const sequence = numberField(parsed.sequence);
      if (sequence !== undefined) maxSequence = Math.max(maxSequence, sequence);
      if (parsed.type === "run_end") sawRunEnd = true;
      if (sequence !== undefined && sequence <= run.lastSequence) continue;
      records.push({
        record: parsed,
        ...(sequence !== undefined ? { sequence } : {}),
        source: { sourceKey, line },
      });
    }
  }
  if (options.includeTerminalFallback !== false && !sawRunEnd) {
    const terminal = terminalRunEndRecord(
      readPiWorkflowRun(runDir),
      Math.max(maxSequence + 1, run.lastSequence + 1),
    );
    const sequence = numberField(terminal?.sequence);
    if (terminal && (sequence === undefined || sequence > run.lastSequence)) {
      records.push({
        record: terminal,
        ...(sequence !== undefined ? { sequence } : {}),
        source: { sourceKey: `run-json:${runDir}`, line: 1 },
      });
    }
  }
  return { records, nextTail: { offset: nextOffset, line: nextLine } };
}

export function runCursorFromWorkflowRecord(
  record: Record<string, unknown>,
  fallbackRunId?: string,
): PiWorkflowRunCursor | undefined {
  const runId = stringField(record.runId) ?? fallbackRunId;
  if (!runId) return undefined;
  return {
    runId,
    lastSequence: numberField(record.sequence) ?? 0,
    ...(stringField(record.runDir) ? { runDir: stringField(record.runDir)! } : {}),
    ...(stringField(record.auditPath) ? { auditPath: stringField(record.auditPath)! } : {}),
    ...(workflowStatusFromRecord(record) ? { status: workflowStatusFromRecord(record)! } : {}),
  };
}

export function workflowStatusFromRecord(record: Record<string, unknown>): string | undefined {
  const explicit = stringField(record.status);
  if (explicit) return explicit;
  if (record.type === "run_start") return "running";
  if (record.type === "run_resume_requested") return "recovering";
  if (record.type === "run_paused") return "paused";
  if (record.type === "run_interrupted") return "interrupted";
  return undefined;
}

export function isTerminalWorkflowRecord(record: Record<string, unknown>): boolean {
  return record.type === "run_end" || isTerminalWorkflowStatus(workflowStatusFromRecord(record));
}

function terminalRunEndRecord(
  run: PiWorkflowRunRecord | undefined,
  sequence: number,
): Record<string, unknown> | undefined {
  if (!run || !isTerminalWorkflowStatus(run.status)) return undefined;
  return withoutUndefined({
    type: "run_end",
    timestamp: stringField(run.endedAt) ?? runJsonMtime(run.runDir),
    runId: run.id,
    rootWorkflowId: stringField(run.rootWorkflowId) ?? stringField(run.workflowId),
    workflowId: stringField(run.workflowId) ?? stringField(run.rootWorkflowId),
    commandName: stringField(run.commandName),
    cwd: run.cwd,
    parentSessionFile: stringField(run.parentSessionFile),
    runDir: run.runDir,
    auditPath: stringField(run.auditPath),
    status: run.status,
    error: stringField(run.error),
    sequence,
    eventId: `${run.id}:run_end:run-json`,
    reconciledFrom: "run.json",
  });
}

function resolveWorkflowRunDir(target: string, root: string): string {
  if (target.includes(sep) || target.includes("/") || target.includes("\\")) return resolve(target);
  return join(root, target);
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readWorkflowEventsRange(
  filePath: string,
  requestedOffset: number,
): { readonly text?: string; readonly nextOffset: number } {
  let fd: number | undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return { nextOffset: requestedOffset };
    const start = stat.size < requestedOffset ? 0 : requestedOffset;
    const length = stat.size - start;
    if (length <= 0) return { nextOffset: start };
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return { nextOffset: start };
    const completeText = text.slice(0, lastNewline + 1);
    return { text: completeText, nextOffset: start + Buffer.byteLength(completeText) };
  } catch {
    return { nextOffset: requestedOffset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runJsonMtime(runDir: string): string {
  try {
    return statSync(join(runDir, "run.json")).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
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

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
