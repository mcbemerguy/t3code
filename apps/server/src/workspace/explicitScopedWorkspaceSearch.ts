// @effect-diagnostics nodeBuiltinImport:off
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import type { ProjectEntry } from "@t3tools/contracts";

export interface ExplicitScopedQuery {
  readonly scopeRelativePath: string;
  readonly nestedQuery: string;
}

export interface ExplicitScopedWorkspaceScopeIndexInput {
  readonly cwd: string;
  readonly scopeRelativePath: string;
  readonly path: Path.Path;
  readonly ignoredDirectoryNames: ReadonlySet<string>;
  readonly maxEntries: number;
  readonly readdirConcurrency: number;
}

export interface ExplicitScopedWorkspaceSearchInput extends Omit<
  ExplicitScopedWorkspaceScopeIndexInput,
  "scopeRelativePath"
> {
  readonly rawQuery: string;
  readonly indexedPaths: ReadonlySet<string>;
}

export interface ExplicitScopedWorkspaceScopeIndex {
  readonly entries: ProjectEntry[];
  readonly truncated: boolean;
}

export interface ExplicitScopedWorkspaceSearchResult extends ExplicitScopedWorkspaceScopeIndex {
  readonly nestedQuery: string;
}

interface PendingDirectory {
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface DirectoryReadResult {
  readonly directory: PendingDirectory;
  readonly dirents: Dirent[] | null;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function trimComposerPathQuery(input: string): string {
  let query = toPosixPath(input.trim());
  if (query.startsWith("@")) {
    query = query.slice(1);
  }
  while (query.startsWith("./")) {
    query = query.slice(2);
  }
  return query;
}

function hasGitDirectorySegment(relativePath: string): boolean {
  return relativePath.split("/").includes(".git");
}

function hasUnsafeRelativeSegment(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

export function parseExplicitScopedWorkspaceQuery(rawQuery: string): ExplicitScopedQuery | null {
  const query = trimComposerPathQuery(rawQuery);
  const separatorIndex = query.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const scopeRelativePath = query.slice(0, separatorIndex);
  if (
    query.startsWith("/") ||
    query.startsWith("../") ||
    hasUnsafeRelativeSegment(scopeRelativePath) ||
    hasGitDirectorySegment(scopeRelativePath)
  ) {
    return null;
  }

  return {
    scopeRelativePath,
    nestedQuery: query.slice(separatorIndex + 1),
  };
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function isSafeRealScope(input: {
  readonly realCwd: string;
  readonly realScope: string;
  readonly path: Path.Path;
}): boolean {
  const relativeFromCwd = toPosixPath(input.path.relative(input.realCwd, input.realScope));
  return (
    relativeFromCwd.length > 0 &&
    relativeFromCwd !== ".." &&
    !relativeFromCwd.startsWith("../") &&
    !input.path.isAbsolute(relativeFromCwd)
  );
}

function scopedEntryPath(scopeRelativePath: string, entryRelativePath: string): string {
  return toPosixPath(`${scopeRelativePath}/${entryRelativePath}`);
}

function shouldSkipDirectory(input: {
  readonly name: string;
  readonly projectRelativePath: string;
  readonly ignoredDirectoryNames: ReadonlySet<string>;
}): boolean {
  if (hasGitDirectorySegment(input.projectRelativePath)) {
    return true;
  }
  return input.ignoredDirectoryNames.has(input.name);
}

const safeResolveDirectoryInsideCwd = (input: {
  readonly cwd: string;
  readonly absoluteScope: string;
  readonly path: Path.Path;
}): Effect.Effect<string | null, never> =>
  Effect.promise(async () => {
    try {
      const [realCwd, realScope] = await Promise.all([
        fsPromises.realpath(input.cwd),
        fsPromises.realpath(input.absoluteScope),
      ]);
      if (!isSafeRealScope({ realCwd, realScope, path: input.path })) {
        return null;
      }
      const stats = await fsPromises.stat(realScope);
      return stats.isDirectory() ? realScope : null;
    } catch {
      return null;
    }
  });

const safeReadDirectory = (
  directory: PendingDirectory,
): Effect.Effect<DirectoryReadResult, never> =>
  Effect.promise(async () => {
    try {
      const dirents = await fsPromises.readdir(directory.absolutePath, { withFileTypes: true });
      return { directory, dirents };
    } catch {
      return { directory, dirents: null };
    }
  });

export const buildExplicitScopedWorkspaceScopeIndex = Effect.fn(
  "buildExplicitScopedWorkspaceScopeIndex",
)(function* (
  input: ExplicitScopedWorkspaceScopeIndexInput,
): Effect.fn.Return<ExplicitScopedWorkspaceScopeIndex | null, never> {
  const absoluteScope = input.path.resolve(input.cwd, input.scopeRelativePath);
  const resolvedScope = yield* safeResolveDirectoryInsideCwd({
    cwd: input.cwd,
    absoluteScope,
    path: input.path,
  });
  if (!resolvedScope) {
    return null;
  }

  const entries: ProjectEntry[] = [];
  let pendingDirectories: PendingDirectory[] = [{ relativePath: "", absolutePath: resolvedScope }];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];

    const directoryReads = yield* Effect.forEach(currentDirectories, safeReadDirectory, {
      concurrency: input.readdirConcurrency,
    });

    for (const readResult of directoryReads) {
      if (!readResult.dirents) {
        continue;
      }

      readResult.dirents.sort((left, right) => left.name.localeCompare(right.name));
      for (const dirent of readResult.dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const scopedRelativePath = toPosixPath(
          readResult.directory.relativePath
            ? input.path.join(readResult.directory.relativePath, dirent.name)
            : dirent.name,
        );
        const projectRelativePath = scopedEntryPath(input.scopeRelativePath, scopedRelativePath);

        if (
          dirent.isDirectory() &&
          shouldSkipDirectory({
            name: dirent.name,
            projectRelativePath,
            ignoredDirectoryNames: input.ignoredDirectoryNames,
          })
        ) {
          continue;
        }
        if (!dirent.isDirectory() && hasGitDirectorySegment(projectRelativePath)) {
          continue;
        }

        entries.push({
          path: projectRelativePath,
          kind: dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(projectRelativePath),
        });

        if (dirent.isDirectory()) {
          pendingDirectories.push({
            relativePath: scopedRelativePath,
            absolutePath: input.path.join(resolvedScope, scopedRelativePath),
          });
        }

        if (entries.length >= input.maxEntries) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    entries,
    truncated,
  };
});

export const searchExplicitScopedWorkspaceEntries = Effect.fn(
  "searchExplicitScopedWorkspaceEntries",
)(function* (
  input: ExplicitScopedWorkspaceSearchInput,
): Effect.fn.Return<ExplicitScopedWorkspaceSearchResult | null, never> {
  const parsedQuery = parseExplicitScopedWorkspaceQuery(input.rawQuery);
  if (!parsedQuery || input.indexedPaths.has(parsedQuery.scopeRelativePath)) {
    return null;
  }

  const scopeIndex = yield* buildExplicitScopedWorkspaceScopeIndex({
    cwd: input.cwd,
    scopeRelativePath: parsedQuery.scopeRelativePath,
    path: input.path,
    ignoredDirectoryNames: input.ignoredDirectoryNames,
    maxEntries: input.maxEntries,
    readdirConcurrency: input.readdirConcurrency,
  });
  if (!scopeIndex) {
    return null;
  }

  return {
    ...scopeIndex,
    nestedQuery: parsedQuery.nestedQuery,
  };
});
