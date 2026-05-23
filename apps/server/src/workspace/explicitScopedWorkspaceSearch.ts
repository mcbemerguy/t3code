// @effect-diagnostics nodeBuiltinImport:off
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import type { ProjectEntry } from "@t3tools/contracts";

interface ExplicitScopedQuery {
  readonly scopeRelativePath: string;
  readonly nestedQuery: string;
}

export interface ExplicitScopedWorkspaceSearchInput {
  readonly cwd: string;
  readonly rawQuery: string;
  readonly indexedPaths: ReadonlySet<string>;
  readonly path: Path.Path;
  readonly ignoredDirectoryNames: ReadonlySet<string>;
  readonly maxEntries: number;
  readonly readdirConcurrency: number;
}

export interface ExplicitScopedWorkspaceSearchResult {
  readonly entries: ProjectEntry[];
  readonly nestedQuery: string;
  readonly truncated: boolean;
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

function parseExplicitScopedQuery(rawQuery: string): ExplicitScopedQuery | null {
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

function isSafeResolvedScope(input: {
  readonly cwd: string;
  readonly absoluteScope: string;
  readonly path: Path.Path;
}): boolean {
  const relativeFromCwd = toPosixPath(input.path.relative(input.cwd, input.absoluteScope));
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

const safeStatDirectory = (absolutePath: string): Effect.Effect<boolean, never> =>
  Effect.promise(async () => {
    try {
      const stats = await fsPromises.stat(absolutePath);
      return stats.isDirectory();
    } catch {
      return false;
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

export const searchExplicitScopedWorkspaceEntries = Effect.fn(
  "searchExplicitScopedWorkspaceEntries",
)(function* (
  input: ExplicitScopedWorkspaceSearchInput,
): Effect.fn.Return<ExplicitScopedWorkspaceSearchResult | null, never> {
  const parsedQuery = parseExplicitScopedQuery(input.rawQuery);
  if (!parsedQuery || input.indexedPaths.has(parsedQuery.scopeRelativePath)) {
    return null;
  }

  const absoluteScope = input.path.resolve(input.cwd, parsedQuery.scopeRelativePath);
  if (!isSafeResolvedScope({ cwd: input.cwd, absoluteScope, path: input.path })) {
    return null;
  }

  const scopeExists = yield* safeStatDirectory(absoluteScope);
  if (!scopeExists) {
    return null;
  }

  const entries: ProjectEntry[] = [];
  let pendingDirectories: PendingDirectory[] = [{ relativePath: "", absolutePath: absoluteScope }];
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
        const projectRelativePath = scopedEntryPath(
          parsedQuery.scopeRelativePath,
          scopedRelativePath,
        );

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
            absolutePath: input.path.join(absoluteScope, scopedRelativePath),
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
    nestedQuery: parsedQuery.nestedQuery,
    truncated,
  };
});
