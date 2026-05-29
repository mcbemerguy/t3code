const MAX_AUTOLINK_PATH_LENGTH = 300;
const GLOB_CHARS = ["*", "?", "[", "]", "{", "}"] as const;
const SHELL_CONTROL_CHARS = ["`", "$", "|", "&", ";", "<", ">", "\n", "\r", "\0"] as const;
const URL_LIKE_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const UNC_PATH_PATTERN = /^\\\\/u;
const EXPLICIT_RELATIVE_PATH_PATTERN = /^(?:~\/|\.{1,2}[\\/])/u;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/u;

const POSIX_FILESYSTEM_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/workspace/",
  "/workspaces/",
  "/repo/",
  "/srv/",
] as const;

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

export function isHighConfidenceAutolinkPath(raw: string, cwd?: string): boolean {
  const value = stripOneSurroundingQuotePair(raw.trim()).trim();

  if (value.length === 0 || value.length > MAX_AUTOLINK_PATH_LENGTH) return false;
  if (URL_LIKE_PATTERN.test(value)) return false;
  if (containsAny(value, GLOB_CHARS)) return false;
  if (containsAny(value, SHELL_CONTROL_CHARS)) return false;
  if (isGenericOnlySnippet(value)) return false;

  const pathWithoutPosition = value.replace(POSITION_SUFFIX_PATTERN, "");
  const basename = basenameOfPathCandidate(pathWithoutPosition);
  if (!basename) return false;

  if (
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(pathWithoutPosition) ||
    UNC_PATH_PATTERN.test(pathWithoutPosition)
  ) {
    return hasKnownExtensionOrAllowedName(basename);
  }

  if (pathWithoutPosition.startsWith("/")) {
    if (!POSIX_FILESYSTEM_ROOT_PREFIXES.some((prefix) => pathWithoutPosition.startsWith(prefix))) {
      return false;
    }
    return hasKnownExtensionOrAllowedName(basename);
  }

  if (EXPLICIT_RELATIVE_PATH_PATTERN.test(pathWithoutPosition)) {
    return hasKnownExtensionOrAllowedName(basename);
  }

  if (pathWithoutPosition.includes("/") || pathWithoutPosition.includes("\\")) {
    return hasKnownExtensionOrAllowedName(basename);
  }

  return Boolean(cwd) && isAllowedBareFilename(basename);
}

function containsAny(value: string, chars: ReadonlyArray<string>): boolean {
  return chars.some((char) => value.includes(char));
}

function hasKnownExtensionOrAllowedName(basename: string): boolean {
  if (isAllowedBareFilename(basename)) return true;
  const extensionStart = basename.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === basename.length - 1) return false;
  return KNOWN_FILE_EXTENSIONS.has(basename.slice(extensionStart + 1).toLowerCase());
}

function isAllowedBareFilename(value: string): boolean {
  return ALLOWED_BARE_FILENAMES.has(value.toLowerCase());
}

function basenameOfPathCandidate(value: string): string {
  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
}

function stripOneSurroundingQuotePair(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  return value;
}

function isGenericOnlySnippet(value: string): boolean {
  return /^<[^<>\\/]+>$/u.test(value.trim());
}
