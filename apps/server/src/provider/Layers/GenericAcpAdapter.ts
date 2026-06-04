import {
  ApprovalRequestId,
  type ChatAttachment,
  type CustomAcpSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderWorkflowControlAction,
  type ProviderWorkflowRunCursor,
  type ServerProviderSlashCommand,
  type ProviderUserInputAnswers,
  type ThreadTokenUsageSnapshot,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  areAcpTokenUsageSnapshotsEqual,
  mergeAcpTokenUsageSnapshot,
  normalizeAcpPromptUsage,
} from "../acp/AcpUsage.ts";
import {
  AskQuestionRequest,
  extractAskQuestions,
  makeAskQuestionResponse,
} from "../acp/AskQuestionExtension.ts";
import { applyGenericAcpSessionConfiguration } from "../acp/GenericAcpAdapterMode.ts";
import { makeCustomAcpRuntime } from "../acp/CustomAcpSupport.ts";
import {
  ACP_SESSION_DELETE_METHOD,
  extractAcpSessionLifecycleCapabilities,
  type AcpSessionLifecycleCapabilities,
} from "../acp/AcpSessionLifecycle.ts";
import {
  extractPiWorkflowCapabilities,
  makeCustomAcpResumeCursor,
  parseCustomAcpResume,
  type PiWorkflowCapabilities,
  type PiWorkflowResumeRun,
  PI_WORKFLOWS_EVENTS_METHOD,
  workflowCursorFromControlResponse,
  workflowCursorFromResumeRun,
  workflowMetaFromRawPayload,
  workflowRunFromRecord,
} from "../acp/PiWorkflowExtension.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const CUSTOM_ACP_PROVIDER = ProviderDriverKind.make("customAcp");
const ACP_CANCEL_WATCHDOG_GRACE_MS = 2_500;
const ACP_CANCEL_PROMPT_DRAIN_MS = 500;
const ACP_SESSION_LIFECYCLE_GRACE_MS = 2_500;

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface GenericAcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly acpSessionId: string;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  latestTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  runtimeEventTurnId: TurnId | undefined;
  piSteeringMethod: string | undefined;
  acpSessionLifecycleCapabilities: AcpSessionLifecycleCapabilities;
  piWorkflowCapabilities: PiWorkflowCapabilities | undefined;
  readonly workflowRuns: Map<string, PiWorkflowResumeRun>;
  readonly duplicateWorkflowEventRuns: Set<string>;
  readonly workflowCursors: Map<string, ProviderWorkflowRunCursor>;
  readonly completedTurnIds: Set<TurnId>;
  readonly cancellingTurnIds: Set<TurnId>;
  readonly turnGate: Semaphore.Semaphore;
  turnIdle: Deferred.Deferred<void>;
  readonly turnCancelSignals: Map<TurnId, Deferred.Deferred<void>>;
  readonly turnPromptCompletions: Map<
    TurnId,
    Deferred.Deferred<Exit.Exit<EffectAcpSchema.PromptResponse, ProviderAdapterError>>
  >;
  stopped: boolean;
}

export interface GenericAcpAdapterOptions {
  readonly provider?: ProviderDriverKind;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly resolveSettings?: Effect.Effect<CustomAcpSettings>;
  readonly onSlashCommandsUpdated?: (
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresStrictPiAcpResume(raw: unknown, piSteeringMethod: string | undefined): boolean {
  if (piSteeringMethod !== undefined) return true;
  if (!isRecord(raw)) return false;
  const agentCapabilities = raw.agentCapabilities;
  return (
    hasPiAcpMetadataRecord(raw._meta) ||
    (isRecord(agentCapabilities) && hasPiAcpMetadataRecord(agentCapabilities._meta))
  );
}

function hasPiAcpMetadataRecord(meta: unknown): boolean {
  return isRecord(meta) && isRecord(meta.piAcp);
}

function currentRuntimeEventTurnId(ctx: GenericAcpSessionContext): TurnId | undefined {
  return ctx.activeTurnId ?? ctx.runtimeEventTurnId;
}

function activeWorkflowCursors(
  ctx: GenericAcpSessionContext,
): ReadonlyArray<ProviderWorkflowRunCursor> {
  return Array.from(ctx.workflowCursors.values()).filter((run) => !run.terminal);
}

function workflowControlMethod(
  capabilities: PiWorkflowCapabilities | undefined,
  action: ProviderWorkflowControlAction,
): string | undefined {
  switch (action) {
    case "continue":
    case "resume":
      return capabilities?.resumeMethod;
    case "interrupt":
      return capabilities?.interruptMethod;
    case "pause":
      return capabilities?.pauseMethod;
    case "abort":
      return capabilities?.abortMethod;
  }
}

function providerAdapterErrorDetail(error: ProviderAdapterError): string {
  switch (error._tag) {
    case "ProviderAdapterRequestError":
    case "ProviderAdapterProcessError":
      return error.detail;
    case "ProviderAdapterValidationError":
      return error.issue;
    case "ProviderAdapterSessionClosedError":
    case "ProviderAdapterSessionNotFoundError":
    default:
      return error.message;
  }
}

function promptFailureDetail(cause: Cause.Cause<ProviderAdapterError>): string {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  return failure ? providerAdapterErrorDetail(failure) : Cause.pretty(cause);
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    request.options.find((option) => option.kind === "allow_always")?.optionId?.trim() ||
    request.options.find((option) => option.kind === "allow_once")?.optionId?.trim() ||
    undefined
  );
}

export function makeGenericAcpAdapter(
  settings: CustomAcpSettings,
  options?: GenericAcpAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | Scope.Scope
  | Crypto.Crypto
> {
  return Effect.gen(function* () {
    const provider = options?.provider ?? CUSTOM_ACP_PROVIDER;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(String(provider));
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GenericAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Custom ACP runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Custom ACP extension event.",
              cause,
            }),
        ),
      );
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const refreshResumeCursor = (ctx: GenericAcpSessionContext) => {
      const strictResume =
        isRecord(ctx.session.resumeCursor) && ctx.session.resumeCursor.requireSessionLoad === true;
      ctx.session = {
        ...ctx.session,
        resumeCursor: makeCustomAcpResumeCursor({
          provider,
          sessionId: ctx.acpSessionId,
          ...(strictResume ? { requireSessionLoad: true } : {}),
          activeWorkflowRuns: Array.from(ctx.workflowRuns.values()),
        }),
        workflowRuns: activeWorkflowCursors(ctx),
      };
    };

    const emitWorkflowRunUpdated = (
      ctx: GenericAcpSessionContext,
      cursor: ProviderWorkflowRunCursor,
      rawPayload: unknown,
    ) =>
      makeEventStamp().pipe(
        Effect.flatMap((stamp) =>
          offerRuntimeEvent({
            type: "workflow.run.updated",
            ...stamp,
            provider,
            threadId: ctx.threadId,
            turnId: currentRuntimeEventTurnId(ctx),
            payload: { run: cursor },
            raw: {
              source: "acp.pi-workflows.extension",
              method: "workflow.run.updated",
              payload: rawPayload,
            },
          }),
        ),
      );

    const upsertWorkflowRunCursor = (
      ctx: GenericAcpSessionContext,
      run: PiWorkflowResumeRun,
      cursor: ProviderWorkflowRunCursor,
    ) => {
      if (cursor.terminal) {
        ctx.workflowRuns.delete(run.runId);
        ctx.workflowCursors.delete(run.runId);
      } else {
        ctx.workflowRuns.set(run.runId, run);
        ctx.workflowCursors.set(run.runId, cursor);
      }
      refreshResumeCursor(ctx);
    };

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      source: "acp.jsonrpc" | "acp.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider,
              createdAt: observedAt,
              method,
              threadId,
              payload,
              source,
            },
          },
          threadId,
        );
      });

    const releaseTurnReservation = (ctx: GenericAcpSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        ctx.turnCancelSignals.delete(turnId);
        ctx.turnPromptCompletions.delete(turnId);
        if (ctx.activeTurnId !== turnId) return;
        ctx.activeTurnId = undefined;
        yield* Deferred.succeed(ctx.turnIdle, undefined).pipe(Effect.ignore);
      });

    const completeTurnLocally = (
      ctx: GenericAcpSessionContext,
      turnId: TurnId,
      payload: {
        readonly state: "cancelled" | "failed";
        readonly stopReason: string | null;
        readonly errorMessage?: string;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.completedTurnIds.has(turnId)) return;
        ctx.completedTurnIds.add(turnId);
        ctx.cancellingTurnIds.delete(turnId);
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        void _activeTurnId;
        ctx.session = { ...sessionWithoutActiveTurn, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider,
          threadId: ctx.threadId,
          turnId,
          payload,
        });
        yield* releaseTurnReservation(ctx, turnId);
      });

    const shouldSuppressWorkflowUpdate = (ctx: GenericAcpSessionContext, rawPayload: unknown) => {
      const meta = workflowMetaFromRawPayload(rawPayload);
      return meta !== undefined && ctx.duplicateWorkflowEventRuns.has(meta.runId);
    };

    const emitPlanUpdate = (
      ctx: GenericAcpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const eventTurnId = currentRuntimeEventTurnId(ctx);
        const fingerprint = `${eventTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider,
            threadId: ctx.threadId,
            turnId: eventTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const buildPromptParts = (input: {
      readonly input?: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly method: string;
    }) =>
      Effect.gen(function* () {
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) promptParts.push({ type: "text", text: input.input.trim() });
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider,
                method: input.method,
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: input.method,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }
        return promptParts;
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GenericAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const settleActiveTurnsAsCancelled = (
      ctx: GenericAcpSessionContext,
      stopReason: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [turnId, completion] of ctx.turnPromptCompletions) {
          if (ctx.completedTurnIds.has(turnId)) continue;
          ctx.cancellingTurnIds.add(turnId);
          yield* Deferred.succeed(
            completion,
            Exit.fail(
              new ProviderAdapterRequestError({
                provider,
                method: "session/prompt",
                detail: stopReason,
              }),
            ),
          ).pipe(Effect.ignore);
        }
      });

    const prepareSessionStop = (ctx: GenericAcpSessionContext, stopReason: string) =>
      Effect.gen(function* () {
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* settleActiveTurnsAsCancelled(ctx, stopReason);
      });

    const finalizeSessionStop = (ctx: GenericAcpSessionContext, detach: boolean) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          const interrupt = Fiber.interrupt(ctx.notificationFiber);
          const interruptEffect = detach
            ? interrupt.pipe(Effect.forkDetach, Effect.ignore)
            : interrupt;
          yield* interruptEffect;
        }
        const closeScope = Scope.close(ctx.scope, Exit.void);
        const closeScopeEffect = detach
          ? closeScope.pipe(Effect.forkDetach, Effect.ignore)
          : Effect.ignore(closeScope);
        yield* closeScopeEffect;
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const emitLifecycleWarning = (
      ctx: GenericAcpSessionContext,
      message: string,
      detail: unknown,
    ) =>
      makeEventStamp().pipe(
        Effect.flatMap((stamp) =>
          offerRuntimeEvent({
            type: "runtime.warning",
            ...stamp,
            provider,
            threadId: ctx.threadId,
            payload: { message, detail },
          }),
        ),
      );

    const closeAcpSessionIfSupported = (ctx: GenericAcpSessionContext) => {
      if (!ctx.acpSessionLifecycleCapabilities.close) return Effect.void;
      return ctx.acp.close.pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          mapAcpToAdapterError(provider, ctx.threadId, "session/close", error),
        ),
      );
    };

    const failUnsupportedSessionDelete = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider,
          method: ACP_SESSION_DELETE_METHOD,
          detail: `ACP provider does not support ${ACP_SESSION_DELETE_METHOD}; backing session history was not removed.`,
        }),
      );

    const fallbackFromUnsupportedSessionDelete = (ctx: GenericAcpSessionContext) =>
      emitLifecycleWarning(
        ctx,
        `ACP provider does not support ${ACP_SESSION_DELETE_METHOD}; backing session history was not removed.`,
        { method: ACP_SESSION_DELETE_METHOD, sessionId: ctx.acpSessionId },
      ).pipe(
        Effect.andThen(closeAcpSessionIfSupported(ctx)),
        Effect.andThen(failUnsupportedSessionDelete()),
      );

    const deleteAcpSessionIfSupported = (ctx: GenericAcpSessionContext) => {
      const deleteMethod = ctx.acpSessionLifecycleCapabilities.deleteMethod;
      if (!deleteMethod) {
        return fallbackFromUnsupportedSessionDelete(ctx);
      }
      const payload = { sessionId: ctx.acpSessionId };
      return ctx.acp.request(deleteMethod, payload).pipe(
        Effect.asVoid,
        Effect.catch((error) => {
          if (error._tag !== "AcpRequestError" || error.code !== -32601) {
            return Effect.fail(mapAcpToAdapterError(provider, ctx.threadId, deleteMethod, error));
          }
          return fallbackFromUnsupportedSessionDelete(ctx);
        }),
      );
    };

    const runBoundedAcpLifecycle = (
      ctx: GenericAcpSessionContext,
      method: string,
      effect: Effect.Effect<void, ProviderAdapterError>,
      failOnError: boolean,
    ): Effect.Effect<void, ProviderAdapterError> =>
      effect.pipe(
        Effect.timeoutOption(Duration.millis(ACP_SESSION_LIFECYCLE_GRACE_MS)),
        Effect.flatMap((result) => {
          if (result._tag === "Some") return Effect.void;
          const error = new ProviderAdapterRequestError({
            provider,
            method,
            detail: `${method} did not settle before local runtime cleanup.`,
          });
          const warning = emitLifecycleWarning(
            ctx,
            `${method} timed out; local runtime was still stopped.`,
            {
              error: error.message,
            },
          );
          return failOnError ? warning.pipe(Effect.andThen(Effect.fail(error))) : warning;
        }),
        Effect.catch((error) => {
          const warning = emitLifecycleWarning(
            ctx,
            `${method} failed; local runtime was still stopped.`,
            {
              error: error.message,
            },
          );
          return failOnError ? warning.pipe(Effect.andThen(Effect.fail(error))) : warning;
        }),
      );

    const runSessionLifecycleStop = (
      ctx: GenericAcpSessionContext,
      options?: {
        readonly deleteBackingSession?: boolean;
        readonly detach?: boolean;
        readonly skipAcpLifecycle?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        const deleteBackingSession = options?.deleteBackingSession === true;
        const method = deleteBackingSession
          ? (ctx.acpSessionLifecycleCapabilities.deleteMethod ?? ACP_SESSION_DELETE_METHOD)
          : "session/close";
        yield* Effect.logInfo("custom ACP session lifecycle requested", {
          provider,
          threadId: ctx.threadId,
          acpSessionId: ctx.acpSessionId,
          method,
          deleteBackingSession,
        });
        const acpLifecycle: Effect.Effect<void, ProviderAdapterError> = options?.skipAcpLifecycle
          ? Effect.void
          : runBoundedAcpLifecycle(
              ctx,
              method,
              deleteBackingSession
                ? deleteAcpSessionIfSupported(ctx)
                : closeAcpSessionIfSupported(ctx),
              deleteBackingSession,
            );
        const lifecycleEffect = prepareSessionStop(ctx, `${method} requested`).pipe(
          Effect.andThen(acpLifecycle),
        );
        const lifecycleExit = yield* lifecycleEffect.pipe(Effect.exit);
        yield* finalizeSessionStop(ctx, options?.detach === true);
        if (Exit.isFailure(lifecycleExit)) {
          return yield* Effect.failCause(lifecycleExit.cause);
        }
      });

    const stopSessionInternal = (ctx: GenericAcpSessionContext) => runSessionLifecycleStop(ctx);

    const stopSessionWithoutWaitingForPrompt = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber).pipe(Effect.forkDetach, Effect.ignore);
        }
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.forkDetach, Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== provider) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: `Expected provider '${provider}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: GenericAcpSessionContext;

          const effectiveSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : settings;
          if (!effectiveSettings.command.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "Custom ACP command is required.",
            });
          }

          const resumeTarget = parseCustomAcpResume(provider, input.resumeCursor);
          const resumeSessionId = resumeTarget?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider,
            threadId: input.threadId,
          });
          const acp = yield* makeCustomAcpRuntime({
            settings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId
              ? {
                  resumeSessionId,
                  ...(resumeTarget.requireResumeSession ? { requireResumeSession: true } : {}),
                }
              : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            const askQuestionMethod = effectiveSettings.askQuestionMethod.trim();
            const extensionSource = `acp.${provider}.extension` as const;
            if (effectiveSettings.askQuestionEnabled && askQuestionMethod) {
              yield* acp.handleExtRequest(askQuestionMethod, AskQuestionRequest, (params) =>
                mapExtensionFailure(
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, askQuestionMethod, params, "acp.extension");
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                    const requestTurnId = ctx ? currentRuntimeEventTurnId(ctx) : undefined;
                    pendingUserInputs.set(requestId, { answers });
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp()),
                      provider,
                      threadId: input.threadId,
                      turnId: requestTurnId,
                      requestId: runtimeRequestId,
                      payload: { questions: extractAskQuestions(params) },
                      raw: { source: extensionSource, method: askQuestionMethod, payload: params },
                    });
                    const resolved = yield* Deferred.await(answers);
                    pendingUserInputs.delete(requestId);
                    yield* offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* makeEventStamp()),
                      provider,
                      threadId: input.threadId,
                      turnId: requestTurnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolved },
                    });
                    return makeAskQuestionResponse(resolved);
                  }),
                ),
              );
            }

            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: { outcome: "selected" as const, optionId: autoApprovedOptionId },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const requestTurnId = ctx ? currentRuntimeEventTurnId(ctx) : undefined;
                  pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider,
                      threadId: input.threadId,
                      turnId: requestTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider,
                      threadId: input.threadId,
                      turnId: requestTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: acpPermissionOutcome(resolved),
                          },
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, "session/start", error),
            ),
          );

          yield* applyGenericAcpSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(provider, input.threadId, method, cause),
          });

          const acpSessionLifecycleCapabilities = extractAcpSessionLifecycleCapabilities(
            started.initializeResult,
          );
          const piWorkflowCapabilities = extractPiWorkflowCapabilities(started.initializeResult);
          const now = yield* nowIso;
          const resumedWorkflowRuns = new Map(
            (resumeTarget?.activeWorkflowRuns ?? []).map((run) => [run.runId, run] as const),
          );
          const resumedWorkflowCursors = new Map(
            (resumeTarget?.activeWorkflowRuns ?? []).flatMap((run) => {
              const cursor = workflowCursorFromResumeRun({
                run,
                capabilities: piWorkflowCapabilities,
                updatedAt: now,
              });
              return cursor ? [[run.runId, cursor] as const] : [];
            }),
          );
          const session: ProviderSession = {
            provider,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: makeCustomAcpResumeCursor({
              provider,
              sessionId: started.sessionId,
              ...(requiresStrictPiAcpResume(started.initializeResult, started.piSteeringMethod)
                ? { requireSessionLoad: true }
                : {}),
              activeWorkflowRuns: Array.from(resumedWorkflowRuns.values()),
            }),
            workflowRuns: Array.from(resumedWorkflowCursors.values()).filter(
              (run) => !run.terminal,
            ),
            createdAt: now,
            updatedAt: now,
          };

          const turnGate = yield* Semaphore.make(1);
          const turnIdle = yield* Deferred.make<void>();
          yield* Deferred.succeed(turnIdle, undefined);

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            latestTokenUsage: undefined,
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            runtimeEventTurnId: undefined,
            piSteeringMethod: started.piSteeringMethod,
            acpSessionLifecycleCapabilities,
            piWorkflowCapabilities,
            workflowRuns: resumedWorkflowRuns,
            duplicateWorkflowEventRuns: new Set(),
            workflowCursors: resumedWorkflowCursors,
            completedTurnIds: new Set(),
            cancellingTurnIds: new Set(),
            turnGate,
            turnIdle,
            turnCancelSignals: new Map(),
            turnPromptCompletions: new Map(),
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                const eventTurnId = currentRuntimeEventTurnId(ctx);
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AvailableCommandsUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    if (options?.onSlashCommandsUpdated) {
                      yield* options.onSlashCommandsUpdated(event.commands);
                    }
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    if (shouldSuppressWorkflowUpdate(ctx, event.rawPayload)) return;
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    if (shouldSuppressWorkflowUpdate(ctx, event.rawPayload)) return;
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    if (shouldSuppressWorkflowUpdate(ctx, event.rawPayload)) return;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: eventTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        streamKind: event.streamKind,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "WorkflowEventObserved": {
                    yield* logNative(
                      ctx.threadId,
                      ctx.piWorkflowCapabilities?.eventsMethod ?? PI_WORKFLOWS_EVENTS_METHOD,
                      event.rawPayload,
                      "acp.extension",
                    );
                    const previous = ctx.workflowRuns.get(event.runId);
                    const duplicate =
                      previous !== undefined && event.sequence <= previous.lastSequence;
                    if (duplicate) {
                      ctx.duplicateWorkflowEventRuns.add(event.runId);
                      return;
                    }
                    ctx.duplicateWorkflowEventRuns.delete(event.runId);
                    const run = workflowRunFromRecord(
                      event.runId,
                      event.sequence,
                      event.record,
                      previous,
                    );
                    const cursor = workflowCursorFromResumeRun({
                      run,
                      capabilities: ctx.piWorkflowCapabilities,
                      updatedAt: yield* nowIso,
                    });
                    if (!cursor) return;
                    upsertWorkflowRunCursor(ctx, run, cursor);
                    yield* emitWorkflowRunUpdated(ctx, cursor, event.rawPayload);
                    return;
                  }
                  case "TokenUsageUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    if (shouldSuppressWorkflowUpdate(ctx, event.rawPayload)) return;
                    const mergedUsage = mergeAcpTokenUsageSnapshot(
                      ctx.latestTokenUsage,
                      event.usage,
                    );
                    if (areAcpTokenUsageSnapshotsEqual(ctx.latestTokenUsage, mergedUsage)) {
                      return;
                    }
                    ctx.latestTokenUsage = mergedUsage;
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider,
                      threadId: ctx.threadId,
                      turnId: eventTurnId,
                      payload: { usage: ctx.latestTokenUsage },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/update",
                        payload: event.rawPayload,
                      },
                    });
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Custom ACP runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Custom ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomUUIDv4);
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const promptParts = yield* buildPromptParts({
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          method: "session/prompt",
        });

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        yield* ctx.turnGate.withPermit(
          Effect.gen(function* () {
            yield* Deferred.await(ctx.turnIdle);
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider,
                threadId: input.threadId,
              });
            }
            ctx.turnIdle = yield* Deferred.make<void>();
            const signal = yield* Deferred.make<void>();
            ctx.turnCancelSignals.set(turnId, signal);
            ctx.activeTurnId = turnId;
            ctx.runtimeEventTurnId = turnId;
            ctx.lastPlanFingerprint = undefined;
            ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
            return signal;
          }),
        );

        const promptRequest = ctx.acp
          .prompt({ prompt: promptParts })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, "session/prompt", error),
            ),
          );

        const promptResult = yield* Effect.gen(function* () {
          yield* applyGenericAcpSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection:
              model === undefined ? undefined : { model, options: turnModelSelection?.options },
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(provider, input.threadId, method, cause),
          });

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider,
            threadId: input.threadId,
            turnId,
            payload: { model: model ?? "default" },
          });

          const promptSettled =
            yield* Deferred.make<Exit.Exit<EffectAcpSchema.PromptResponse, ProviderAdapterError>>();
          ctx.turnPromptCompletions.set(turnId, promptSettled);
          yield* Effect.sync(() => {
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            Effect.runFork(
              promptRequest.pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.succeed(promptSettled, exit)),
              ),
            );
          });

          const promptExit = yield* Deferred.await(promptSettled);
          if (Exit.isFailure(promptExit)) {
            if (ctx.completedTurnIds.has(turnId)) return undefined;
            if (ctx.cancellingTurnIds.has(turnId)) {
              yield* completeTurnLocally(ctx, turnId, {
                state: "cancelled",
                stopReason: "session/cancel requested",
              });
              return undefined;
            }
            const detail = promptFailureDetail(promptExit.cause);
            yield* completeTurnLocally(ctx, turnId, {
              state: "failed",
              stopReason: "session/prompt failed",
              errorMessage: detail,
            });
            return undefined;
          }
          return promptExit.value;
        }).pipe(Effect.onError(() => releaseTurnReservation(ctx, turnId)));

        if (promptResult === undefined || ctx.completedTurnIds.has(turnId)) {
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }

        const wasCancelling = ctx.cancellingTurnIds.delete(turnId);
        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result: promptResult }] });
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        void _activeTurnId;
        ctx.session = { ...sessionWithoutActiveTurn, updatedAt: yield* nowIso, model };

        ctx.completedTurnIds.add(turnId);
        const promptUsage = normalizeAcpPromptUsage(promptResult.usage);
        if (promptUsage) {
          const mergedUsage = mergeAcpTokenUsageSnapshot(ctx.latestTokenUsage, promptUsage);
          if (!areAcpTokenUsageSnapshotsEqual(ctx.latestTokenUsage, mergedUsage)) {
            ctx.latestTokenUsage = mergedUsage;
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              ...(yield* makeEventStamp()),
              provider,
              threadId: input.threadId,
              turnId,
              payload: { usage: ctx.latestTokenUsage },
              raw: {
                source: "acp.jsonrpc",
                method: "session/prompt",
                payload: promptResult,
              },
            });
          }
        }

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider,
          threadId: input.threadId,
          turnId,
          payload: {
            state:
              wasCancelling || promptResult.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason:
              wasCancelling && promptResult.stopReason !== "cancelled"
                ? "session/cancel requested"
                : (promptResult.stopReason ?? null),
          },
        });
        yield* releaseTurnReservation(ctx, turnId);

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const sendActiveTurnInput: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["sendActiveTurnInput"]
    > = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (!ctx.activeTurnId || ctx.activeTurnId !== input.turnId || !ctx.piSteeringMethod) {
          return false;
        }
        const promptParts = yield* buildPromptParts({
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          method: ctx.piSteeringMethod,
        });
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendActiveTurnInput",
            issue: "Active-turn input requires non-empty text or attachments.",
          });
        }
        yield* ctx.acp
          .request(ctx.piSteeringMethod, {
            sessionId: ctx.acpSessionId,
            prompt: promptParts,
            mode: "steer",
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, ctx.piSteeringMethod!, error),
            ),
          );
        return true;
      });

    const controlWorkflowRun: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["controlWorkflowRun"]
    > = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const method = workflowControlMethod(ctx.piWorkflowCapabilities, input.action);
        if (!method) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "controlWorkflowRun",
            issue: `Workflow action '${input.action}' is not supported by this ACP provider.`,
          });
        }
        const current = ctx.workflowRuns.get(input.runId);
        const payload = {
          sessionId: ctx.acpSessionId,
          runId: input.runId,
          reason: `User requested workflow ${input.action} from t3code.`,
          ...(input.continuationMessage !== undefined
            ? { continuationMessage: input.continuationMessage }
            : {}),
        };
        yield* logNative(ctx.threadId, method, payload, "acp.extension");
        const raw = yield* ctx.acp
          .request(method, payload)
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(provider, input.threadId, method, error),
            ),
          );
        const cursor = workflowCursorFromControlResponse({
          runId: input.runId,
          lastSequence: current?.lastSequence ?? 0,
          raw,
          capabilities: ctx.piWorkflowCapabilities,
          updatedAt: yield* nowIso,
        });
        if (!cursor) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method,
            detail: "Workflow control response did not include a valid run cursor.",
          });
        }
        upsertWorkflowRunCursor(
          ctx,
          {
            runId: cursor.runId,
            lastSequence: cursor.lastSequence,
            ...(cursor.runDir ? { runDir: cursor.runDir } : {}),
            ...(cursor.auditPath ? { auditPath: cursor.auditPath } : {}),
            status: cursor.status,
          },
          cursor,
        );
        yield* emitWorkflowRunUpdated(ctx, cursor, raw);
        return { run: cursor };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const interruptedTurnId = turnId ?? ctx.activeTurnId;
        if (interruptedTurnId && !ctx.completedTurnIds.has(interruptedTurnId)) {
          ctx.cancellingTurnIds.add(interruptedTurnId);
          const cancelSignal = ctx.turnCancelSignals.get(interruptedTurnId);
          if (cancelSignal) {
            yield* Deferred.succeed(cancelSignal, undefined).pipe(Effect.ignore);
          }
          const promptCompletion = ctx.turnPromptCompletions.get(interruptedTurnId);
          if (promptCompletion) {
            yield* Effect.sync(() => {
              // @effect-diagnostics-next-line runEffectInsideEffect:off
              Effect.runFork(
                Effect.sleep(Duration.millis(ACP_CANCEL_PROMPT_DRAIN_MS)).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      if (ctx.completedTurnIds.has(interruptedTurnId) || ctx.stopped) return;
                      yield* Deferred.succeed(
                        promptCompletion,
                        Exit.fail(
                          new ProviderAdapterRequestError({
                            provider,
                            method: "session/prompt",
                            detail: "Prompt did not settle after session/cancel.",
                          }),
                        ),
                      ).pipe(Effect.ignore);
                      yield* stopSessionWithoutWaitingForPrompt(ctx);
                    }),
                  ),
                ),
              );
            });
          }
        }
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(provider, threadId, "session/cancel", error),
          ),
          Effect.exit,
          Effect.timeoutOption(Duration.millis(ACP_CANCEL_WATCHDOG_GRACE_MS)),
          Effect.flatMap((cancelExit) => {
            if (!interruptedTurnId || ctx.stopped || ctx.completedTurnIds.has(interruptedTurnId)) {
              return Effect.void;
            }
            if (cancelExit._tag === "Some" && Exit.isSuccess(cancelExit.value)) {
              return Effect.void;
            }
            return completeTurnLocally(ctx, interruptedTurnId, {
              state: "cancelled",
              stopReason: "session/cancel requested",
            }).pipe(Effect.andThen(stopSessionInternal(ctx)));
          }),
          Effect.forkDetach,
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "customAcp/ask_question",
            detail: `unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (
      threadId,
      options,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* runSessionLifecycleStop(
            ctx,
            options?.deleteBackingSession ? { deleteBackingSession: true } : undefined,
          );
        }),
      );

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Custom ACP session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      sendActiveTurnInput,
      interruptTurn,
      controlWorkflowRun,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
