import { isHighConfidenceAutolinkPath } from "./fileLinkCandidate";
import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

export interface TerminalLinkBufferPosition {
  x: number;
  y: number;
}

export interface TerminalLinkBufferRange {
  start: TerminalLinkBufferPosition;
  end: TerminalLinkBufferPosition;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g;
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g;
const EXPLICIT_WINDOWS_PATH_START_PATTERN = /[A-Za-z]:[\\/]|\\\\/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
const MAX_EXPLICIT_PATH_SCAN_LENGTH = 400;
const PATH_CANDIDATE_HARD_DELIMITERS = new Set(['"', "'", "`", "<", ">", "\n", "\r", "\0"]);
const POSITION_SUFFIX_AT_START_PATTERN = /^:\d+(?::\d+)?/;
const PATH_CANDIDATE_BOUNDARY_PATTERN = /[\s),.;!?\]}]/;

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, "");
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (kind === "path" && /^https?:\/\//i.test(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function isPathCandidateBoundary(value: string | undefined): boolean {
  return value === undefined || PATH_CANDIDATE_BOUNDARY_PATTERN.test(value);
}

function isExplicitWindowsPathStartAt(line: string, index: number): boolean {
  return /^[A-Za-z]:[\\/]/.test(line.slice(index, index + 3)) || line.startsWith("\\\\", index);
}

function scanPathCandidateEnd(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    if (PATH_CANDIDATE_HARD_DELIMITERS.has(line[index] ?? "")) return index;
    if (
      index > start &&
      isPathCandidateBoundary(line[index - 1]) &&
      isExplicitWindowsPathStartAt(line, index)
    ) {
      return index;
    }
  }
  return line.length;
}

function resolveExplicitPathCandidate(raw: string): string | null {
  const value = raw.slice(0, MAX_EXPLICIT_PATH_SCAN_LENGTH);

  for (let end = 1; end <= value.length; end += 1) {
    const prefix = trimClosingDelimiters(value.slice(0, end).trimEnd());
    if (prefix.length === 0 || !isHighConfidenceAutolinkPath(prefix)) continue;

    const remaining = value.slice(end);
    const positionMatch = remaining.match(POSITION_SUFFIX_AT_START_PATTERN);
    if (positionMatch?.[0]) {
      const candidateWithPosition = `${prefix}${positionMatch[0]}`;
      const afterPosition = value[end + positionMatch[0].length];
      if (
        isPathCandidateBoundary(afterPosition) &&
        isHighConfidenceAutolinkPath(candidateWithPosition)
      ) {
        return candidateWithPosition;
      }
      continue;
    }

    if (isPathCandidateBoundary(value[end])) return prefix;
  }

  return null;
}

function collectExplicitWindowsPathMatches(
  line: string,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  EXPLICIT_WINDOWS_PATH_START_PATTERN.lastIndex = 0;

  for (const rawMatch of line.matchAll(EXPLICIT_WINDOWS_PATH_START_PATTERN)) {
    const start = rawMatch.index ?? -1;
    if (start < 0) continue;

    const scanEnd = scanPathCandidateEnd(line, start);
    const raw = line.slice(start, scanEnd);
    const text = resolveExplicitPathCandidate(raw);
    if (!text) continue;

    const candidate: TerminalLinkMatch = {
      kind: "path",
      text,
      start,
      end: start + text.length,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function collectPathMatches(line: string, existing: TerminalLinkMatch[]): TerminalLinkMatch[] {
  const explicitWindowsMatches = collectExplicitWindowsPathMatches(line, existing);
  const genericMatches = collectMatches(line, "path", FILE_PATH_PATTERN, [
    ...existing,
    ...explicitWindowsMatches,
  ]);
  return [...explicitWindowsMatches, ...genericMatches];
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const pathMatches = collectPathMatches(line, urlMatches);
  return [...urlMatches, ...pathMatches].toSorted((a, b) => a.start - b.start);
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

function resolveCharacterPosition(
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>,
  characterIndex: number,
): TerminalLinkBufferPosition {
  for (const segment of segments) {
    if (characterIndex < segment.endIndex) {
      return {
        x: characterIndex - segment.startIndex + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    x: Math.max(lastSegment?.text.length ?? 0, 1),
    y: lastSegment?.bufferLineNumber ?? 1,
  };
}

export function resolveWrappedTerminalLinkRange(
  wrappedLine: WrappedTerminalLinkLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkBufferRange {
  return {
    start: resolveCharacterPosition(wrappedLine.segments, match.start),
    end: resolveCharacterPosition(wrappedLine.segments, match.end - 1),
  };
}

export function wrappedTerminalLinkRangeIntersectsBufferLine(
  range: TerminalLinkBufferRange,
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}
