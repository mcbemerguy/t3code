import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "./markdown-links";

const MAX_CODE_SPAN_PATH_LENGTH = 300;
const URL_LIKE_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const EXPLICIT_PATH_PREFIX_PATTERN = /^(?:~\/|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const KNOWN_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bat",
  "c",
  "cc",
  "cmd",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "fish",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);
const ALLOWED_BARE_FILENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".env.example",
  ".eslintrc",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  "agents.md",
  "bun.lock",
  "bunfig.toml",
  "cargo.lock",
  "cargo.toml",
  "claude.md",
  "dockerfile",
  "gemini.md",
  "go.mod",
  "go.sum",
  "makefile",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "readme.md",
  "requirements.txt",
  "tsconfig.json",
  "vite.config.ts",
  "yarn.lock",
]);

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
  if (EXPLICIT_PATH_PREFIX_PATTERN.test(value)) return true;

  const pathWithoutPosition = value.replace(POSITION_SUFFIX_PATTERN, "");
  const basename = basenameOfPathCandidate(pathWithoutPosition);
  if (!basename) return false;

  if (hasKnownFileExtension(basename)) return true;
  return isAllowedBareFilename(basename);
}

function basenameOfPathCandidate(value: string): string {
  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
}

function isAllowedBareFilename(value: string): boolean {
  return ALLOWED_BARE_FILENAMES.has(value.toLowerCase());
}

function hasKnownFileExtension(value: string): boolean {
  const extensionStart = value.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === value.length - 1) return false;
  return KNOWN_FILE_EXTENSIONS.has(value.slice(extensionStart + 1).toLowerCase());
}
