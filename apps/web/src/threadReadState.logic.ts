import type { Thread } from "./types";

type ThreadVisitedSeedInput = Pick<Thread, "createdAt" | "updatedAt" | "latestTurn" | "session">;

export function deriveThreadVisitedSeedAt(thread: ThreadVisitedSeedInput): string | undefined {
  return maxValidTimestamp([
    thread.createdAt,
    thread.updatedAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    thread.session?.updatedAt,
  ]);
}

function maxValidTimestamp(candidates: readonly (string | null | undefined)[]): string | undefined {
  let selected: string | undefined;
  let selectedMs = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs) || candidateMs <= selectedMs) {
      continue;
    }

    selected = candidate;
    selectedMs = candidateMs;
  }

  return selected;
}
