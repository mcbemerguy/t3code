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
  extractPiWorkflowCapabilities,
  isTerminalWorkflowStatus,
  makeCustomAcpResumeCursor,
  parseCustomAcpResume,
  parsePiWorkflowRuns,
  type PiWorkflowCapabilities,
  type PiWorkflowResumeRun,
  workflowMetaFromRawPayload,
  workflowRunFromRecord,
} from "../acp/PiWorkflowExtension.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const CUSTOM_ACP_PROVIDER = ProviderDriverKind.make("customAcp");
const ACP_CANCEL_WATCHDOG_GRACE_MS = 2_500;
const ACP_CANCEL_PROMPT_DRAIN_MS = 500;

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
  piWorkflowCapabilities: PiWorkflowCapabilities | undefined;
  readonly workflowRuns: Map<string, PiWorkflowResumeRun>;
  readonly duplicateWorkflowEventRuns: Set<string>;
  readonly workflowActionNotices: Set<string>;
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

function mergeWorkflowRunCursor(
  previous: PiWorkflowResumeRun | undefined,
  next: PiWorkflowResumeRun,
): PiWorkflowResumeRun {
  if (!previous) return next;
  return {
    runId: next.runId,
    lastSequence: Math.max(previous.lastSequence, next.lastSequence),
    ...((next.runDir ?? previous.runDir) ? { runDir: next.runDir ?? previous.runDir } : {}),
    ...((next.auditPath ?? previous.auditPath)
      ? { auditPath: next.auditPath ?? previous.auditPath }
      : {}),
    ...((next.status ?? previous.status) ? { status: next.status ?? previous.status } : {}),
  };
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
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingUserInputs.values(),
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
      };
    };

    const upsertWorkflowRunCursor = (
      ctx: GenericAcpSessionContext,
      run: PiWorkflowResumeRun,
      terminal: boolean,
    ) => {
      if (terminal) ctx.workflowRuns.delete(run.runId);
      else
        ctx.workflowRuns.set(
          run.runId,
          mergeWorkflowRunCursor(ctx.workflowRuns.get(run.runId), run),
        );
      refreshResumeCursor(ctx);
    };

    const emitWorkflowActionNotice = (
      ctx: GenericAcpSessionContext,
      run: PiWorkflowResumeRun,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        if (ctx.workflowActionNotices.has(run.runId)) return;
        ctx.workflowActionNotices.add(run.runId);
        const auditText = run.auditPath ? ` Open audit: ${run.auditPath}.` : "";
        yield* offerRuntimeEvent(
          makeAcpContentDeltaEvent({
            stamp: yield* makeEventStamp(),
            provider,
            threadId: ctx.threadId,
            turnId: currentRuntimeEventTurnId(ctx),
            streamKind: "assistant_text",
            text: `Workflow ${run.runId} is active. Available actions: resume, pause, abort.${auditText}`,
            rawPayload,
          }),
        );
      });

    const discoverActiveWorkflowRuns = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        const knownRuns = Array.from(ctx.workflowRuns.values());
        const listMethod = ctx.piWorkflowCapabilities?.listMethod;
        if (!listMethod) return knownRuns;
        const payload = {
          sessionId: ctx.acpSessionId,
          status: ["running", "recovering"],
        };
        yield* logNative(ctx.threadId, listMethod, payload, "acp.extension");
        const listExit = yield* ctx.acp
          .request(listMethod, payload)
          .pipe(Effect.exit, Effect.timeoutOption(Duration.millis(ACP_CANCEL_WATCHDOG_GRACE_MS)));
        if (listExit._tag === "None" || Exit.isFailure(listExit.value)) return knownRuns;
        const mergedRuns = new Map(knownRuns.map((run) => [run.runId, run] as const));
        for (const run of parsePiWorkflowRuns(listExit.value.value).filter(
          (run) =>
            run.status !== "completed" && run.status !== "failed" && run.status !== "aborted",
        )) {
          mergedRuns.set(run.runId, mergeWorkflowRunCursor(mergedRuns.get(run.runId), run));
        }
        return Array.from(mergedRuns.values());
      });

    const pauseActiveWorkflows = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        const pauseMethod = ctx.piWorkflowCapabilities?.pauseMethod;
        if (!pauseMethod) return false;
        const runs = yield* discoverActiveWorkflowRuns(ctx);
        if (runs.length === 0) return false;
        for (const run of runs) {
          const payload = {
            sessionId: ctx.acpSessionId,
            runId: run.runId,
            reason: "User requested workflow interruption from t3code.",
          };
          yield* logNative(ctx.threadId, pauseMethod, payload, "acp.extension");
          const pauseExit = yield* ctx.acp
            .request(pauseMethod, payload)
            .pipe(Effect.exit, Effect.timeoutOption(Duration.millis(ACP_CANCEL_WATCHDOG_GRACE_MS)));
          if (pauseExit._tag === "None" || Exit.isFailure(pauseExit.value)) return false;
        }
        for (const run of runs) {
          upsertWorkflowRunCursor(ctx, { ...run, status: "paused" }, false);
        }
        yield* offerRuntimeEvent(
          makeAcpContentDeltaEvent({
            stamp: yield* makeEventStamp(),
            provider,
            threadId: ctx.threadId,
            turnId: currentRuntimeEventTurnId(ctx),
            streamKind: "assistant_text",
            text: "Workflow pause requested. Use the workflow resume or abort action to continue or terminate it explicitly.",
            rawPayload: { activeWorkflowRuns: runs.map((run) => run.runId) },
          }),
        );
        return true;
      });

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

    const stopSessionInternal = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

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

          const piWorkflowCapabilities = extractPiWorkflowCapabilities(started.initializeResult);
          const resumedWorkflowRuns = new Map(
            (resumeTarget?.activeWorkflowRuns ?? []).map((run) => [run.runId, run] as const),
          );
          const now = yield* nowIso;
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
            piWorkflowCapabilities,
            workflowRuns: resumedWorkflowRuns,
            duplicateWorkflowEventRuns: new Set(),
            workflowActionNotices: new Set(),
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
                      ctx.piWorkflowCapabilities?.eventsMethod ?? "_pi/workflows/events",
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
                    const run = workflowRunFromRecord(event.runId, event.sequence, event.record);
                    const terminal = isTerminalWorkflowStatus(run.status);
                    upsertWorkflowRunCursor(ctx, run, terminal);
                    if (!terminal) yield* emitWorkflowActionNotice(ctx, run, event.rawPayload);
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

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pausedWorkflow = yield* pauseActiveWorkflows(ctx);
        if (pausedWorkflow) {
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
          return;
        }
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

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
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
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      sendActiveTurnInput,
      interruptTurn,
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
