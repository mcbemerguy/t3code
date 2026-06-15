// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { CanonicalItemType } from "@t3tools/contracts";

const TEXT_LIMIT_BYTES = 64 * 1024;
const DIFF_FILE_LIMIT_BYTES = 256 * 1024;

export interface PiToolSnapshot {
  readonly path: string;
  readonly oldText?: string;
  readonly skippedReason?: string;
}

export interface PiToolEndPresentation {
  readonly outputText?: string;
  readonly unifiedDiff?: string;
  readonly diagnostic?: string;
}

export function toPiToolItemType(toolName: string | undefined): CanonicalItemType {
  const normalized = (toolName ?? "").toLowerCase();
  if (normalized === "bash" || normalized === "shell" || normalized === "run")
    return "command_execution";
  if (normalized === "edit" || normalized === "write" || normalized === "apply_patch")
    return "file_change";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

export function toolResultToText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return truncateText(result);

  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return "";
          const item = entry as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("");
      if (text) return truncateText(text);
    }

    const details =
      typeof record.details === "object" && record.details !== null
        ? (record.details as Record<string, unknown>)
        : undefined;
    const diff = typeof details?.diff === "string" ? details.diff : undefined;
    if (diff?.trim()) return truncateText(diff);

    const stdout = firstString(details?.stdout, record.stdout, details?.output, record.output);
    const stderr = firstString(details?.stderr, record.stderr);
    const exitCode = firstNumber(details?.exitCode, record.exitCode, details?.code, record.code);
    if (stdout?.trim() || stderr?.trim()) {
      const parts = [];
      if (stdout?.trim()) parts.push(stdout);
      if (stderr?.trim()) parts.push(`stderr:\n${stderr}`);
      if (exitCode !== undefined) parts.push(`exit code: ${exitCode}`);
      return truncateText(parts.join("\n\n").trimEnd());
    }
  }

  return truncateText(safeJson(result));
}

export function captureEditSnapshot(
  toolName: string,
  args: unknown,
  cwd: string,
): PiToolSnapshot | undefined {
  if (toolName !== "edit" && toolName !== "write" && toolName !== "apply_patch") return undefined;
  const path = readStringField(args, "path");
  if (!path) return undefined;
  const absolutePath = isAbsolute(path) ? path : resolvePath(cwd, path);

  try {
    if (!existsSync(absolutePath)) return { path, oldText: "" };
    const stat = statSync(absolutePath);
    if (stat.size > DIFF_FILE_LIMIT_BYTES) {
      return {
        path,
        skippedReason: `structured diff omitted because pre-edit file is ${stat.size} bytes`,
      };
    }
    return { path, oldText: readFileSync(absolutePath, "utf8") };
  } catch {
    return undefined;
  }
}

export function buildToolEndPresentation(input: {
  readonly cwd: string;
  readonly result: unknown;
  readonly updates: ReadonlyArray<unknown>;
  readonly snapshot?: PiToolSnapshot;
}): PiToolEndPresentation {
  const outputText = toolResultToText(input.result) ?? mergedUpdateText(input.updates);
  const snapshot = input.snapshot;
  if (!snapshot) return outputText ? { outputText } : {};
  if (snapshot.skippedReason) {
    return { ...(outputText ? { outputText } : {}), diagnostic: snapshot.skippedReason };
  }
  if (snapshot.oldText === undefined) return outputText ? { outputText } : {};

  try {
    const absolutePath = isAbsolute(snapshot.path)
      ? snapshot.path
      : resolvePath(input.cwd, snapshot.path);
    const stat = statSync(absolutePath);
    if (stat.size > DIFF_FILE_LIMIT_BYTES) {
      return {
        ...(outputText ? { outputText } : {}),
        diagnostic: `structured diff omitted because post-edit file is ${stat.size} bytes`,
      };
    }
    const newText = readFileSync(absolutePath, "utf8");
    if (newText === snapshot.oldText) return outputText ? { outputText } : {};
    return {
      ...(outputText ? { outputText } : {}),
      unifiedDiff: buildUnifiedDiff(snapshot.path, snapshot.oldText, newText),
    };
  } catch {
    return outputText ? { outputText } : {};
  }
}

export function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function mergedUpdateText(updates: ReadonlyArray<unknown>): string | undefined {
  const text = updates
    .map((update) => (typeof update === "string" ? update : toolResultToText(update)))
    .filter(Boolean)
    .join("\n");
  return text ? truncateText(text) : undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstNumber(...values: ReadonlyArray<unknown>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function truncateText(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= TEXT_LIMIT_BYTES) return text;
  return `${Buffer.from(text).subarray(0, TEXT_LIMIT_BYTES).toString("utf8").replace(/�$/u, "")}\n\n[Pi presentation truncated ${bytes - TEXT_LIMIT_BYTES} bytes from ${bytes} total bytes.]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}
