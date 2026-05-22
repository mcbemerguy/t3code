import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "./markdown-links";

const MAX_CODE_SPAN_PATH_LENGTH = 300;
const URL_LIKE_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const FILENAME_WITH_TEXT_EXTENSION_PATTERN =
  /^[A-Za-z0-9._-]+\.[A-Za-z][A-Za-z0-9_-]*(?::\d+){0,2}$/;
const PATH_SIGNAL_PATTERN = /^(?:~\/|\.{1,2}[\/]|[\/]|[A-Za-z]:[\\/]|\\\\)|[\\/]/;

export function resolveMarkdownCodeSpanPathLinkMeta(
  rawText: string,
  cwd: string | undefined,
): MarkdownFileLinkMeta | null {
  if (rawText.length === 0 || rawText.length > MAX_CODE_SPAN_PATH_LENGTH) return null;
  if (rawText.includes("\n") || rawText.includes("\r") || rawText.includes("\0")) return null;
  if (URL_LIKE_PATTERN.test(rawText)) return null;

  const normalized = stripOneSurroundingQuotePair(rawText).trim();
  if (normalized.length === 0 || normalized.length > MAX_CODE_SPAN_PATH_LENGTH) return null;
  if (isGenericOnlySnippet(normalized)) return null;
  if (!hasPathSignal(normalized)) return null;

  return resolveMarkdownFileLinkMeta(normalized, cwd);
}

function stripOneSurroundingQuotePair(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  return value;
}

function isGenericOnlySnippet(value: string): boolean {
  return /^<[^<>\\/]+>$/.test(value.trim());
}

function hasPathSignal(value: string): boolean {
  return PATH_SIGNAL_PATTERN.test(value) || FILENAME_WITH_TEXT_EXTENSION_PATTERN.test(value);
}
