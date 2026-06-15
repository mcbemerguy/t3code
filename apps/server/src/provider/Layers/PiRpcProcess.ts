// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as Readline from "node:readline";
import * as NodeTimers from "node:timers";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import {
  buildPiRpcSpawnArgs,
  buildPiRpcSpawnEnv,
  DEFAULT_PI_RPC_TIMEOUTS,
  errorMessage,
  isPiRpcResponse,
  isStartupCommand,
  parsePiRpcStdoutLine,
  PiRpcLifecycleError,
  PiRpcSpawnError,
  PiRpcTimeoutError,
  shouldUseShellForPiCommand,
  stripAnsi,
  windowsProcessTreeKillCommand,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiRpcRuntimeMessage,
  type PiSessionRuntimeError,
} from "./PiRpcProtocol.ts";

const DIAGNOSTIC_TAIL_MAX_CHARS = 4_000;
const DIAGNOSTIC_TAIL_MAX_LINES = 40;
const TERMINATE_GRACE_TIMEOUT_MS = 1_500;
const TERMINATE_KILL_TIMEOUT_MS = 1_500;

interface PendingRequest {
  readonly command: string;
  writeCompleted: boolean;
  readonly resolve: (value: PiRpcResponse) => void;
  readonly reject: (error: PiSessionRuntimeError) => void;
}

class DiagnosticTail {
  private text = "";

  push(value: unknown): void {
    const raw = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
    const cleaned = stripAnsi(raw);
    if (!cleaned) return;
    this.text = (this.text + cleaned).slice(-DIAGNOSTIC_TAIL_MAX_CHARS * 2);
  }

  get(): string {
    const lines = this.text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-DIAGNOSTIC_TAIL_MAX_LINES);

    const tail = lines.join("\n");
    return tail.length > DIAGNOSTIC_TAIL_MAX_CHARS
      ? `…${tail.slice(-DIAGNOSTIC_TAIL_MAX_CHARS)}`
      : tail;
  }
}

export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();

  if (platform === "win32") {
    const command = windowsProcessTreeKillCommand(pid);
    return new Promise((resolve) => {
      const killer = spawn(command.command, [...command.args], command.options);
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return Promise.resolve();
  }
  return Promise.resolve();
}

export class PiRpcProcessHandle {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly preludeLines: string[] = [];
  private readonly stderrTail = new DiagnosticTail();
  private readonly stdoutPreludeTail = new DiagnosticTail();
  private spawned = false;
  private exited = false;
  private closed = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private closeCode: number | null = null;
  private closeSignal: NodeJS.Signals | null = null;
  private childError: Error | null = null;
  private nextRequestId = 0;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messages: Queue.Queue<PiRpcRuntimeMessage>;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    messages: Queue.Queue<PiRpcRuntimeMessage>,
  ) {
    this.child = child;
    this.messages = messages;
    child.stderr.on("data", (chunk: unknown) => this.stderrTail.push(chunk));

    const readline = Readline.createInterface({ input: child.stdout });
    readline.on("line", (line) => this.handleStdoutLine(line));

    child.on("spawn", () => {
      this.spawned = true;
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
    });

    child.on("close", (code, signal) => {
      this.closed = true;
      this.closeCode = code;
      this.closeSignal = signal;
      this.rejectPendingForProcessExit();
    });

    child.on("error", (error) => {
      this.childError = error;
      const wrapped = this.buildWriteFailureError("process", error);
      for (const [, pending] of this.pending) pending.reject(wrapped);
      this.pending.clear();
    });
  }

  static async spawn(params: {
    readonly command: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly sessionFile?: string;
    readonly messages: Queue.Queue<PiRpcRuntimeMessage>;
  }): Promise<PiRpcProcessHandle> {
    const args = buildPiRpcSpawnArgs(params.sessionFile ? { sessionFile: params.sessionFile } : {});
    const child = spawn(params.command, [...args], {
      cwd: params.cwd,
      stdio: "pipe",
      env: buildPiRpcSpawnEnv(params.environment),
      shell: shouldUseShellForPiCommand(params.command),
    });
    const handle = new PiRpcProcessHandle(child, params.messages);

    try {
      await handle.waitForSpawn();
    } catch (error) {
      const code =
        typeof (error as { readonly code?: unknown }).code === "string"
          ? (error as { readonly code: string }).code
          : undefined;
      throw new PiRpcSpawnError({
        command: params.command,
        args,
        cwd: params.cwd,
        ...(code ? { code } : {}),
        cause: error,
      });
    }

    return handle;
  }

  consumePreludeLines(): ReadonlyArray<string> {
    return this.preludeLines.splice(0, this.preludeLines.length);
  }

  async request(command: PiRpcCommand, timeoutMs: number): Promise<PiRpcResponse> {
    const id = `pi-rpc-${++this.nextRequestId}`;
    const withId = { ...command, id };

    return await new Promise<PiRpcResponse>((resolve, reject) => {
      let settled = false;
      const timeout =
        timeoutMs > 0
          ? NodeTimers.setTimeout(() => {
              if (settled) return;
              settled = true;
              this.pending.delete(id);
              reject(
                new PiRpcTimeoutError({
                  command: command.type,
                  timeoutMs,
                  diagnostics: this.formatDiagnostics(),
                }),
              );
            }, timeoutMs)
          : null;

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) NodeTimers.clearTimeout(timeout);
        complete();
      };

      this.pending.set(id, {
        command: command.type,
        writeCompleted: false,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });

      try {
        this.writeLine(withId, (error) => {
          const pending = this.pending.get(id);
          if (error) {
            this.pending.delete(id);
            finish(() => reject(error));
            return;
          }
          if (pending) pending.writeCompleted = true;
        });
      } catch (error) {
        this.pending.delete(id);
        finish(() => reject(error));
      }
    });
  }

  async send(command: PiRpcCommand): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      try {
        this.writeLine(command, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async terminate(
    opts: {
      readonly attemptAbort?: boolean;
      readonly gracefulTimeoutMs?: number;
      readonly killTimeoutMs?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;

    if (opts.attemptAbort) {
      try {
        await this.request({ type: "abort" }, DEFAULT_PI_RPC_TIMEOUTS.abort);
      } catch {}
    }

    this.dispose("SIGTERM");
    if (await this.waitForClose(opts.gracefulTimeoutMs ?? TERMINATE_GRACE_TIMEOUT_MS)) return;

    if (this.child.pid) await killProcessTree(this.child.pid);
    this.dispose("SIGKILL");
    await this.waitForClose(opts.killTimeoutMs ?? TERMINATE_KILL_TIMEOUT_MS);
  }

  private waitForSpawn(): Promise<void> {
    if (this.spawned) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.child.off("spawn", onSpawn);
        this.child.off("error", onError);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = NodeTimers.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        NodeTimers.clearTimeout(timeout);
        this.child.off("close", onClose);
      };
      this.child.once("close", onClose);
    });
  }

  private dispose(signal: NodeJS.Signals | number): void {
    if (this.child.killed || this.closed) return;
    if (signal === "SIGKILL" && process.platform === "win32" && this.child.pid) {
      void killProcessTree(this.child.pid);
    }
    try {
      this.child.kill(signal as NodeJS.Signals);
    } catch {}
  }

  private handleStdoutLine(line: string): void {
    const parsed = parsePiRpcStdoutLine(line);
    if (!parsed) return;

    if (parsed.kind === "prelude") {
      const prelude = parsed.line ?? "";
      this.preludeLines.push(prelude);
      this.stdoutPreludeTail.push(`${prelude}\n`);
      this.offer({ kind: "prelude", line: prelude });
      return;
    }

    const message = parsed.message;
    if (isPiRpcResponse(message)) {
      if (this.resolveResponse(message)) return;
      this.offer({ kind: "response", payload: message, correlated: false });
      return;
    }

    if (typeof message === "object" && message !== null) {
      this.offer({ kind: "event", payload: message as PiRpcEvent });
    }
  }

  private resolveResponse(response: PiRpcResponse): boolean {
    const id = typeof response.id === "string" ? response.id : undefined;
    if (id) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        this.offer({ kind: "response", payload: response, correlated: true });
        pending.resolve(response);
        return true;
      }
      return false;
    }

    const matches = Array.from(this.pending.entries()).filter(
      ([, pending]) => pending.command === response.command,
    );
    if (matches.length === 1) {
      const [pendingId, pending] = matches[0]!;
      this.pending.delete(pendingId);
      this.offer({ kind: "response", payload: response, correlated: true });
      pending.resolve(response);
      return true;
    }

    return false;
  }

  private writeLine(
    command: PiRpcCommand,
    callback: (error?: PiSessionRuntimeError | null) => void,
  ): void {
    const guarded = this.getWriteGuardError(command.type);
    if (guarded) {
      queueMicrotask(() => callback(guarded));
      return;
    }

    const line = `${JSON.stringify(command)}\n`;
    try {
      this.child.stdin.write(line, (error) => {
        callback(error ? this.buildWriteFailureError(command.type, error) : null);
      });
    } catch (error) {
      throw this.buildWriteFailureError(command.type, error);
    }
  }

  private getWriteGuardError(command: string): PiRpcLifecycleError | null {
    if (!this.spawned)
      return new PiRpcLifecycleError(`Pi RPC process is not spawned; cannot send ${command}.`);
    if (this.exited || this.closed) return this.buildProcessExitError(command);

    const stdin = this.child.stdin;
    if (
      (stdin as { readonly destroyed?: boolean }).destroyed ||
      !stdin.writable ||
      stdin.writableEnded
    ) {
      return this.buildWriteUnavailableError(command);
    }

    return null;
  }

  private rejectPendingForProcessExit(): void {
    for (const [, pending] of this.pending)
      pending.reject(this.buildProcessExitError(pending.command, pending));
    this.pending.clear();
  }

  private buildProcessExitError(
    command: string,
    pending?: Pick<PendingRequest, "writeCompleted">,
  ): PiRpcLifecycleError {
    if (!pending) {
      const prefix = isStartupCommand(command)
        ? `Pi RPC process exited during startup before ${command} could be sent`
        : `Pi RPC process exited before ${command} could be sent`;
      return new PiRpcLifecycleError(`${prefix}. ${this.formatDiagnostics()}`);
    }

    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup before a response to ${command} was received`
      : `Pi RPC process exited before a response to ${command} was received`;
    const delivery = pending.writeCompleted
      ? "request write completed; delivery/processing state is ambiguous"
      : "request write had not completed; delivery state is ambiguous";
    return new PiRpcLifecycleError(`${prefix}; ${delivery}. ${this.formatDiagnostics()}`);
  }

  private buildWriteUnavailableError(command: string): PiRpcLifecycleError {
    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup before ${command} could be sent`
      : `Pi RPC stdin is not writable before ${command} could be sent`;
    return new PiRpcLifecycleError(`${prefix}. ${this.formatDiagnostics({ includeStdin: true })}`);
  }

  private buildWriteFailureError(command: string, cause: unknown): PiRpcLifecycleError {
    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup while sending ${command}`
      : `Pi RPC write failed while sending ${command}`;
    return new PiRpcLifecycleError(
      `${prefix}: ${errorMessage(cause)}. ${this.formatDiagnostics({ includeStdin: true })}`,
      cause,
    );
  }

  private formatDiagnostics(opts: { readonly includeStdin?: boolean } = {}): string {
    const parts = [
      `process status: spawned=${this.spawned}, exited=${this.exited}, closed=${this.closed}, code=${this.exitCode}, signal=${this.exitSignal}, closeCode=${this.closeCode}, closeSignal=${this.closeSignal}`,
    ];

    if (opts.includeStdin) {
      const stdin = this.child.stdin;
      parts.push(
        `stdin status: writable=${stdin.writable}, destroyed=${Boolean((stdin as { readonly destroyed?: boolean }).destroyed)}, writableEnded=${stdin.writableEnded}`,
      );
    }

    if (this.childError) parts.push(`process error: ${errorMessage(this.childError)}`);

    const stderr = this.stderrTail.get();
    if (stderr) parts.push(`stderr tail:\n${stderr}`);

    const stdout = this.stdoutPreludeTail.get();
    if (stdout) parts.push(`stdout/prelude tail:\n${stdout}`);

    return parts.join("\n");
  }

  private offer(message: PiRpcRuntimeMessage): void {
    Effect.runFork(Queue.offer(this.messages, message));
  }
}
