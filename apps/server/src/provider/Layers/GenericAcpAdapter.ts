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
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
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
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { mergeAcpTokenUsageSnapshot, normalizeAcpPromptUsage } from "../acp/AcpUsage.ts";
import {
  AskQuestionRequest,
  extractAskQuestions,
  makeAskQuestionResponse,
} from "../acp/AskQuestionExtension.ts";
import { applyGenericAcpSessionConfiguration } from "../acp/GenericAcpAdapterMode.ts";
import { makeCustomAcpRuntime } from "../acp/CustomAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const CUSTOM_ACP_PROVIDER = ProviderDriverKind.make("customAcp");
const CUSTOM_ACP_RESUME_VERSION = 1 as const;
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
  piSteeringMethod: string | undefined;
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
  readonly instanceId?: typeof ProviderInstanceId.Type;
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

function parseCustomAcpResume(
  provider: ProviderDriverKind,
  raw: unknown,
): { sessionId: string; requireResumeSession: boolean } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CUSTOM_ACP_RESUME_VERSION) return undefined;
  if (raw.provider !== provider) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim(), requireResumeSession: raw.requireSessionLoad === true };
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
> {
  return Effect.gen(function* () {
    const provider = options?.provider ?? CUSTOM_ACP_PROVIDER;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(String(provider));
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GenericAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

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
              id: yield* Random.nextUUIDv4,
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
      payload: { readonly state: "cancelled"; readonly stopReason: string | null },
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
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
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
                Effect.gen(function* () {
                  yield* logNative(input.threadId, askQuestionMethod, params, "acp.extension");
                  const requestId = ApprovalRequestId.make(crypto.randomUUID());
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  const requestTurnId = ctx?.activeTurnId;
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
              );
            }

            yield* acp.handleRequestPermission((params) =>
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
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const requestTurnId = ctx?.activeTurnId;
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
                      : { outcome: "selected" as const, optionId: acpPermissionOutcome(resolved) },
                };
              }),
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

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CUSTOM_ACP_RESUME_VERSION,
              provider,
              sessionId: started.sessionId,
              ...(requiresStrictPiAcpResume(started.initializeResult, started.piSteeringMethod)
                ? { requireSessionLoad: true }
                : {}),
            },
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
            piSteeringMethod: started.piSteeringMethod,
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
                        turnId: ctx.activeTurnId,
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
                        turnId: ctx.activeTurnId,
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
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
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
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        streamKind: event.streamKind,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "TokenUsageUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    ctx.latestTokenUsage = mergeAcpTokenUsageSnapshot(
                      ctx.latestTokenUsage,
                      event.usage,
                    );
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
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
          ).pipe(Effect.forkChild);

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
        const turnId = TurnId.make(crypto.randomUUID());
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
            return yield* Effect.failCause(promptExit.cause);
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
          ctx.latestTokenUsage = mergeAcpTokenUsageSnapshot(ctx.latestTokenUsage, promptUsage);
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
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
