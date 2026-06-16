// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import { type SpawnOptions } from "node:child_process";

import { type ProviderInstanceId, type RuntimeMode, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type PiThinkingLevel } from "./PiThinking.ts";

const ANSI_BEL = 0x07;
const ANSI_ESC = 0x1b;
const ANSI_ST = 0x9c;
const ANSI_CSI = 0x9b;
const ANSI_OSC = 0x9d;
const ANSI_DCS = 0x90;
const ANSI_SOS = 0x98;
const ANSI_PM = 0x9e;
const ANSI_APC = 0x9f;
const ASK_USER_QUESTIONS_TOOL_NAME = "ask_user_questions";

export interface PiRpcTimeouts {
  readonly request: number;
  readonly prompt: number;
  readonly abort: number;
  readonly workflowControl: number;
}

export const DEFAULT_PI_RPC_TIMEOUTS: PiRpcTimeouts = {
  request: 30_000,
  prompt: 0,
  abort: 3_000,
  workflowControl: 5_000,
};

export const PiWorkflowRunCursorSchema = Schema.Struct({
  runId: Schema.String,
  lastSequence: Schema.Number,
  runDir: Schema.optional(Schema.String),
  auditPath: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
export type PiWorkflowRunCursor = typeof PiWorkflowRunCursorSchema.Type;

export const PiResumeCursorSchema = Schema.Struct({
  sessionFile: Schema.String,
  schemaVersion: Schema.optional(Schema.Number),
  provider: Schema.optional(Schema.Literal("pi")),
  providerInstanceId: Schema.optional(Schema.String),
  workflows: Schema.optional(
    Schema.Struct({
      activeRuns: Schema.Array(PiWorkflowRunCursorSchema),
    }),
  ),
});
export type PiResumeCursor = typeof PiResumeCursorSchema.Type;

export type PiWorkflowControlAction = "interrupt" | "pause" | "resume" | "abort";
export type PiWorkflowControlPolicy = "continue-existing-session" | "redo-step" | "manual";

export type PiRpcCommand =
  | {
      readonly type: "prompt";
      readonly id?: string;
      readonly message: string;
      readonly images?: ReadonlyArray<unknown>;
    }
  | {
      readonly type: "steer";
      readonly id?: string;
      readonly message: string;
      readonly images?: ReadonlyArray<unknown>;
    }
  | {
      readonly type: "follow_up";
      readonly id?: string;
      readonly message: string;
      readonly images?: ReadonlyArray<unknown>;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "get_state"; readonly id?: string }
  | { readonly type: "get_available_models"; readonly id?: string }
  | {
      readonly type: "set_model";
      readonly id?: string;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly type: "set_thinking_level"; readonly id?: string; readonly level: PiThinkingLevel }
  | { readonly type: "get_session_stats"; readonly id?: string }
  | { readonly type: "get_messages"; readonly id?: string }
  | {
      readonly type: "workflow_control";
      readonly id?: string;
      readonly action: PiWorkflowControlAction;
      readonly target: string;
      readonly reason?: string;
      readonly policy?: PiWorkflowControlPolicy;
      readonly continuationMessage?: string;
    }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly cancelled?: boolean;
      readonly value?: unknown;
      readonly confirmed?: boolean;
    };

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type PiRpcEvent = Record<string, unknown>;
export type PiRpcRuntimeMessage =
  | { readonly kind: "event"; readonly payload: PiRpcEvent }
  | { readonly kind: "response"; readonly payload: PiRpcResponse; readonly correlated: boolean }
  | { readonly kind: "prelude"; readonly line: string };

export interface PiSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly resumeCursor?: PiResumeCursor;
  readonly timeouts?: Partial<PiRpcTimeouts>;
}

export interface PiWorkflowControlInput {
  readonly action: PiWorkflowControlAction;
  readonly target: string;
  readonly reason?: string;
  readonly policy?: PiWorkflowControlPolicy;
  readonly continuationMessage?: string;
}

export interface PiExtensionUiResponseInput {
  readonly id: string;
  readonly cancelled?: boolean;
  readonly value?: unknown;
  readonly confirmed?: boolean;
}

export type PiSessionRuntimeError =
  | PiRpcSpawnError
  | PiRpcLifecycleError
  | PiRpcTimeoutError
  | PiRpcRequestFailedError;

export class PiRpcSpawnError extends Error {
  readonly _tag = "PiRpcSpawnError";
  readonly code: string | undefined;
  readonly input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly code?: string;
    readonly cause: unknown;
  };

  constructor(input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly code?: string;
    readonly cause: unknown;
  }) {
    super(buildSpawnErrorMessage(input));
    this.name = "PiRpcSpawnError";
    this.input = input;
    this.code = input.code;
  }
}

export class PiRpcLifecycleError extends Error {
  readonly _tag = "PiRpcLifecycleError";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PiRpcLifecycleError";
  }
}

export class PiRpcTimeoutError extends Error {
  readonly _tag = "PiRpcTimeoutError";
  readonly input: {
    readonly command: string;
    readonly timeoutMs: number;
    readonly diagnostics: string;
  };

  constructor(input: {
    readonly command: string;
    readonly timeoutMs: number;
    readonly diagnostics: string;
  }) {
    super(`Pi RPC ${input.command} timed out after ${input.timeoutMs}ms. ${input.diagnostics}`);
    this.name = "PiRpcTimeoutError";
    this.input = input;
  }
}

export class PiRpcRequestFailedError extends Error {
  readonly _tag = "PiRpcRequestFailedError";
  readonly input: { readonly command: string; readonly error?: string; readonly data?: unknown };

  constructor(input: {
    readonly command: string;
    readonly error?: string;
    readonly data?: unknown;
  }) {
    super(`Pi RPC ${input.command} failed: ${input.error ?? JSON.stringify(input.data)}`);
    this.name = "PiRpcRequestFailedError";
    this.input = input;
  }
}

export interface ParsedPiRpcLine {
  readonly kind: "json" | "prelude";
  readonly message?: unknown;
  readonly line?: string;
}

export function stripAnsi(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);

    if (code === ANSI_ESC) {
      index = consumeEscSequence(value, index);
      continue;
    }

    if (code === ANSI_CSI) {
      index = consumeCsiSequence(value, index + 1);
      continue;
    }

    if (code === ANSI_OSC) {
      index = consumeControlString(value, index + 1, true);
      continue;
    }

    if (code === ANSI_DCS || code === ANSI_SOS || code === ANSI_PM || code === ANSI_APC) {
      index = consumeControlString(value, index + 1, false);
      continue;
    }

    if (code === ANSI_BEL || code === ANSI_ST) {
      index++;
      continue;
    }

    result += value[index];
    index++;
  }
  return result;
}

function consumeEscSequence(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (Number.isNaN(next)) return value.length;

  switch (next) {
    case 0x5b:
      return consumeCsiSequence(value, start + 2);
    case 0x5d:
      return consumeControlString(value, start + 2, true);
    case 0x50:
    case 0x58:
    case 0x5e:
    case 0x5f:
      return consumeControlString(value, start + 2, false);
    default:
      return consumeShortEscSequence(value, start + 1);
  }
}

function consumeCsiSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return index;
  }
  return value.length;
}

function consumeControlString(value: string, start: number, allowBel: boolean): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (allowBel && code === ANSI_BEL) return index + 1;
    if (code === ANSI_ST) return index + 1;
    if (code === ANSI_ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function consumeShortEscSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) break;
    index++;
  }

  if (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) return index + 1;
  }

  return start;
}

export function parsePiRpcStdoutLine(line: string): ParsedPiRpcLine | null {
  if (!line.trim()) return null;
  try {
    return { kind: "json", message: JSON.parse(line) };
  } catch {
    const cleaned = stripAnsi(line).trimEnd();
    return cleaned ? { kind: "prelude", line: cleaned } : null;
  }
}

export function defaultPiCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "pi.cmd" : "pi";
}

export function resolvePiCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" && command.trim().toLowerCase() === "pi"
    ? defaultPiCommand(platform)
    : command;
}

export function shouldUseShellForPiCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const normalized = command.trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

export function buildPiRpcSpawnArgs(
  params: { readonly sessionFile?: string } = {},
): ReadonlyArray<string> {
  const args = ["--mode", "rpc", "--no-themes"];
  if (params.sessionFile) args.push("--session", params.sessionFile);
  return args;
}

export function buildPiRpcSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutParentOnlyDelegatedToolCaps({
    ...env,
    PI_ACP: "1",
    PI_ACP_RPC: "1",
  });
}

export function windowsProcessTreeKillCommand(pid: number): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
} {
  return {
    command: "taskkill",
    args: ["/PID", String(pid), "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true },
  };
}

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "response" &&
    typeof record.command === "string" &&
    typeof record.success === "boolean"
  );
}

export function isStartupCommand(type: string): boolean {
  return type === "get_state" || type === "get_available_models";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isUnknownWorkflowControlCommand(error: string | undefined): boolean {
  return typeof error === "string" && /unknown command:\s*workflow_control/i.test(error);
}

export function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function withoutParentOnlyDelegatedToolCaps(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cap = env.PI_DELEGATED_TOOL_CAP;
  if (cap === undefined) return env;

  const remaining = cap
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && tool !== ASK_USER_QUESTIONS_TOOL_NAME);

  if (remaining.length > 0) {
    return { ...env, PI_DELEGATED_TOOL_CAP: remaining.join(",") };
  }

  const { PI_DELEGATED_TOOL_CAP: _removed, ...next } = env;
  return next;
}

function buildSpawnErrorMessage(input: {
  readonly command: string;
  readonly code?: string;
}): string {
  if (input.code === "ENOENT")
    return `Could not start Pi: executable not found (command: ${input.command}).`;
  if (input.code === "EACCES")
    return `Could not start Pi: permission denied (command: ${input.command}).`;
  return `Could not start Pi (command: ${input.command}).`;
}
