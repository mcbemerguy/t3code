// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { CanonicalItemType } from "@t3tools/contracts";

const TEXT_LIMIT_BYTES = 64 * 1024;
const DIFF_FILE_LIMIT_BYTES = 256 * 1024;
const PRESENTATION_ARRAY_LIMIT = 50;
const PRESENTATION_DEPTH_LIMIT = 8;

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

export type PiToolKind =
  | "execute"
  | "read"
  | "write"
  | "edit"
  | "apply_patch"
  | "search"
  | "mcp"
  | "web"
  | "image"
  | "other";

export interface PiToolLifecycleMetadata {
  readonly kind: PiToolKind;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly rawInput?: unknown;
  readonly args?: unknown;
  readonly command?: string;
  readonly path?: string;
  readonly query?: string;
  readonly primaryPath?: string;
}

export interface PiToolLifecyclePresentation {
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly detail?: string;
  readonly data: PiToolLifecycleMetadata;
}

export function toPiToolItemType(toolName: string | undefined): CanonicalItemType {
  const kind = toPiToolKind(toolName);
  if (kind === "execute") return "command_execution";
  if (kind === "edit" || kind === "write" || kind === "apply_patch") return "file_change";
  if (kind === "mcp") return "mcp_tool_call";
  if (kind === "web") return "web_search";
  if (kind === "image") return "image_view";
  return "dynamic_tool_call";
}

export function buildToolLifecyclePresentation(input: {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
}): PiToolLifecyclePresentation {
  const kind = toPiToolKind(input.toolName);
  const command = extractCommandPreview(input.args);
  const path = extractPath(input.args);
  const query = extractQuery(input.args);
  const detail = command ?? path ?? query;
  const safeArgs = sanitizeToolPayloadForPresentation(input.args);
  const data: PiToolLifecycleMetadata = {
    kind,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    ...(input.args !== undefined ? { rawInput: safeArgs, args: safeArgs } : {}),
    ...(command ? { command } : {}),
    ...(path && isFileMutationKind(kind) ? { path } : {}),
    ...(path ? { primaryPath: path } : {}),
    ...(query ? { query } : {}),
  };
  return {
    itemType: toPiToolItemType(input.toolName),
    title: input.toolName,
    ...(detail ? { detail } : {}),
    data,
  };
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
  const outputText =
    toolResultToText(sanitizeToolPayloadForPresentation(input.result)) ??
    mergedUpdateText(input.updates);
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

export function sanitizeToolPayloadForPresentation(value: unknown): unknown {
  return sanitizePresentationValue(value, 0, undefined);
}

export function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function toPiToolKind(toolName: string | undefined): PiToolKind {
  const normalized = (toolName ?? "").toLowerCase();
  if (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "run" ||
    normalized === "execute" ||
    normalized === "exec"
  ) {
    return "execute";
  }
  if (normalized === "read" || normalized === "view") return "read";
  if (normalized === "write" || normalized === "create") return "write";
  if (normalized === "edit" || normalized === "replace") return "edit";
  if (normalized === "apply_patch" || normalized === "apply-patch" || normalized === "patch") {
    return "apply_patch";
  }
  if (
    normalized === "find" ||
    normalized === "grep" ||
    normalized === "search" ||
    normalized === "rg" ||
    normalized.includes("search")
  ) {
    return "search";
  }
  if (normalized.includes("mcp")) return "mcp";
  if (normalized.includes("web")) return "web";
  if (normalized.includes("image")) return "image";
  return "other";
}

function isFileMutationKind(kind: PiToolKind): boolean {
  return kind === "write" || kind === "edit" || kind === "apply_patch";
}

function extractCommandPreview(args: unknown): string | undefined {
  const command = normalizeCommandValue(readField(args, "command") ?? readField(args, "cmd"));
  if (command) return command;
  const executable = readStringField(args, "executable");
  const executableArgs = normalizeCommandValue(readField(args, "args"));
  if (executable && executableArgs) return `${executable} ${executableArgs}`;
  return executable;
}

function extractPath(args: unknown): string | undefined {
  return firstString(
    readStringField(args, "path"),
    readStringField(args, "filePath"),
    readStringField(args, "relativePath"),
    readStringField(args, "filename"),
    readStringField(args, "newPath"),
    readStringField(args, "oldPath"),
  );
}

function extractQuery(args: unknown): string | undefined {
  return firstString(
    readStringField(args, "query"),
    readStringField(args, "pattern"),
    readStringField(args, "searchTerm"),
    readStringField(args, "regex"),
  );
}

function readField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : undefined))
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function mergedUpdateText(updates: ReadonlyArray<unknown>): string | undefined {
  const text = updates
    .map((update) =>
      typeof update === "string"
        ? update
        : toolResultToText(sanitizeToolPayloadForPresentation(update)),
    )
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

function sanitizePresentationValue(
  value: unknown,
  depth: number,
  key: string | undefined,
): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= PRESENTATION_DEPTH_LIMIT) return "[Pi presentation truncated nested value]";

  if (Array.isArray(value)) {
    if (key === "messages") {
      return { stripped: true, count: value.length, reason: "subagent message history omitted" };
    }
    const entries = value
      .slice(0, PRESENTATION_ARRAY_LIMIT)
      .map((entry) => sanitizePresentationValue(entry, depth + 1, undefined));
    if (value.length > PRESENTATION_ARRAY_LIMIT) {
      entries.push({
        truncated: true,
        omitted: value.length - PRESENTATION_ARRAY_LIMIT,
        reason: "Pi presentation array limit",
      });
    }
    return entries;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const isImageRecord =
    record.type === "image" ||
    (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"));

  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (entryValue === undefined) continue;
    if (entryKey === "messages" && Array.isArray(entryValue)) {
      output[entryKey] = {
        stripped: true,
        count: entryValue.length,
        reason: "subagent message history omitted",
      };
      continue;
    }
    if (entryKey === "encrypted_content") {
      output[entryKey] = "[stripped encrypted reasoning payload]";
      continue;
    }
    if (isImageRecord && entryKey === "data") {
      output[entryKey] = "[stripped image data]";
      continue;
    }
    output[entryKey] = sanitizePresentationValue(entryValue, depth + 1, entryKey);
  }
  return output;
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
