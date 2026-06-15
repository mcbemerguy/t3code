// @effect-diagnostics globalDate:off globalTimersInEffect:off runEffectInsideEffect:off
import * as Effect from "effect/Effect";

import type { PiAdapterSessionContext, PiRuntimeEventOffer } from "./PiAdapterTypes.ts";
import {
  defaultPiWorkflowRunsDir,
  isTerminalWorkflowRecord,
  listPiWorkflowRuns,
  parseWorkflowCommandPrompt,
  readPiWorkflowRun,
  replayPiWorkflowEvents,
  runCursorFromWorkflowRecord,
} from "./PiWorkflowArtifacts.ts";
import { isTerminalWorkflowStatus, mergeWorkflowRunCursor } from "./PiWorkflowCursor.ts";
import { PiWorkflowEventMapper } from "./PiWorkflowMapper.ts";
import type { PiWorkflowRunCursor } from "./PiSessionRuntime.ts";

export interface PiWorkflowMonitorOptions {
  readonly pollIntervalMs?: number;
  readonly workflowRunsDir?: string;
  readonly terminalFallbackGraceMs?: number;
  readonly includeTerminalFallback?: boolean;
}

export function workflowCommandTarget(
  message: string,
): ReturnType<typeof parseWorkflowCommandPrompt> {
  return parseWorkflowCommandPrompt(message);
}

export function restorePiWorkflowRuns(
  session: PiAdapterSessionContext,
  offer: PiRuntimeEventOffer,
  options: PiWorkflowMonitorOptions = {},
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const run of Array.from(session.workflowRuns.values())) {
      yield* replayRun(session, offer, run, options);
      if (!isTerminalWorkflowStatus(session.workflowRuns.get(run.runId)?.status)) {
        yield* startPiWorkflowRunMonitor(session, offer, run, options);
      }
    }
  });
}

export function startPiWorkflowCommandMonitor(
  session: PiAdapterSessionContext,
  offer: PiRuntimeEventOffer,
  message: string,
  options: PiWorkflowMonitorOptions = {},
): Effect.Effect<void> {
  const target = parseWorkflowCommandPrompt(message);
  if (!target) return Effect.void;
  return Effect.sync(() => {
    const root = options.workflowRunsDir ?? defaultPiWorkflowRunsDir();
    const known = new Set(listPiWorkflowRuns(root).map((run) => run.id));
    const timer = setInterval(() => {
      if (session.stopped) {
        clearInterval(timer);
        return;
      }
      const run = listPiWorkflowRuns(root).find(
        (entry) =>
          !known.has(entry.id) &&
          entry.cwd === session.cwd &&
          (entry.workflowId === target.workflowId || entry.commandName === target.commandName),
      );
      if (!run) return;
      clearInterval(timer);
      session.workflowMonitorDisposers.delete(dispose);
      const cursor: PiWorkflowRunCursor = {
        runId: run.id,
        lastSequence: 0,
        runDir: run.runDir,
        ...(run.auditPath ? { auditPath: run.auditPath } : {}),
        status: run.status,
      };
      session.workflowRuns.set(run.id, cursor);
      Effect.runFork(
        replayRun(session, offer, cursor, { ...options, includeTerminalFallback: false }).pipe(
          Effect.andThen(() =>
            session.workflowRuns.has(run.id)
              ? startPiWorkflowRunMonitor(session, offer, cursor, options)
              : Effect.void,
          ),
        ),
      );
    }, options.pollIntervalMs ?? 100);
    timer.unref?.();
    const dispose = () => clearInterval(timer);
    session.workflowMonitorDisposers.add(dispose);
  });
}

export function startPiWorkflowRunMonitor(
  session: PiAdapterSessionContext,
  offer: PiRuntimeEventOffer,
  run: PiWorkflowRunCursor,
  options: PiWorkflowMonitorOptions = {},
): Effect.Effect<void> {
  if (session.workflowMonitorRunIds.has(run.runId)) return Effect.void;
  return Effect.sync(() => {
    session.workflowMonitorRunIds.add(run.runId);
    let terminalObservedAt: number | undefined;
    const tick = () => {
      if (session.stopped || !session.workflowRuns.has(run.runId)) {
        dispose();
        return;
      }
      const activeRun = session.workflowRuns.get(run.runId) ?? run;
      Effect.runFork(
        replayRun(session, offer, activeRun, { ...options, includeTerminalFallback: false }).pipe(
          Effect.andThen(() => {
            if (!session.workflowRuns.has(run.runId)) return Effect.void;
            const terminalRun = readPiWorkflowRun(
              activeRun.runDir ?? run.runId,
              options.workflowRunsDir,
            );
            if (!isTerminalWorkflowStatus(terminalRun?.status)) {
              terminalObservedAt = undefined;
              return Effect.void;
            }
            const now = Date.now();
            terminalObservedAt ??= now;
            if (now - terminalObservedAt < (options.terminalFallbackGraceMs ?? 1000))
              return Effect.void;
            return replayRun(session, offer, session.workflowRuns.get(run.runId) ?? activeRun, {
              ...options,
              includeTerminalFallback: true,
            });
          }),
        ),
      );
    };
    const timer = setInterval(tick, options.pollIntervalMs ?? 250);
    timer.unref?.();
    const dispose = () => {
      clearInterval(timer);
      session.workflowMonitorRunIds.delete(run.runId);
      session.workflowMonitorDisposers.delete(dispose);
    };
    session.workflowMonitorDisposers.add(dispose);
    tick();
  });
}

export function replayRun(
  session: PiAdapterSessionContext,
  offer: PiRuntimeEventOffer,
  run: PiWorkflowRunCursor,
  options: PiWorkflowMonitorOptions = {},
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const mapper = session.workflowMapper ?? new PiWorkflowEventMapper();
    session.workflowMapper = mapper;
    const tail = session.workflowTails.get(run.runId);
    const replayOptions = {
      ...(options.workflowRunsDir ? { workflowRunsDir: options.workflowRunsDir } : {}),
      includeTerminalFallback: options.includeTerminalFallback !== false,
      ...(tail ? { startOffset: tail.offset, startLine: tail.line } : {}),
    };
    const batch = replayPiWorkflowEvents(run, replayOptions);
    if (session.workflowRuns.has(run.runId)) session.workflowTails.set(run.runId, batch.nextTail);
    for (const replay of batch.records) {
      const cursor = runCursorFromWorkflowRecord(replay.record, run.runId);
      if (cursor) {
        const previous = session.workflowRuns.get(cursor.runId);
        if (previous && replay.sequence !== undefined && replay.sequence <= previous.lastSequence)
          continue;
        if (isTerminalWorkflowRecord(replay.record)) {
          session.workflowRuns.delete(cursor.runId);
          session.workflowTails.delete(cursor.runId);
        } else session.workflowRuns.set(cursor.runId, mergeWorkflowRunCursor(previous, cursor));
      }
      const events = mapper.map(session, replay);
      if (events.length > 0) yield* offer(events);
    }
  });
}

export function stopWorkflowMonitors(session: PiAdapterSessionContext): Effect.Effect<void> {
  return Effect.sync(() => {
    for (const dispose of Array.from(session.workflowMonitorDisposers)) dispose();
    session.workflowMonitorDisposers.clear();
    session.workflowMonitorRunIds.clear();
  });
}
