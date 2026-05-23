import {
  CommandId,
  CustomAcpSessionImportError,
  EventId,
  ProviderDriverKind,
  ThreadId,
  CustomAcpSettings,
  type CustomAcpSessionImportInput,
  type CustomAcpSessionImportResult,
  type CustomAcpSessionListInput,
  type CustomAcpSessionListResult,
  type ProviderSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpSchema from "effect-acp/schema";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import {
  buildCustomAcpClientCapabilities,
  makeCustomAcpRuntime,
  normalizeCustomAcpAuthMethodId,
} from "./CustomAcpSupport.ts";

const CUSTOM_ACP_DRIVER = ProviderDriverKind.make("customAcp");
const CUSTOM_ACP_SESSION_LIST_TIMEOUT_MS = 15_000;
const decodeInitializeResponse = Schema.decodeUnknownEffect(EffectAcpSchema.InitializeResponse);
const decodeListSessionsResponse = Schema.decodeUnknownEffect(EffectAcpSchema.ListSessionsResponse);
const decodeCustomAcpSettings = Schema.decodeUnknownEffect(CustomAcpSettings);
const isCustomAcpSessionImportError = Schema.is(CustomAcpSessionImportError);

function importError(input: {
  readonly operation: "list" | "import";
  readonly providerInstanceId?: CustomAcpSessionListInput["providerInstanceId"];
  readonly reason: string;
  readonly cause?: unknown;
}) {
  return new CustomAcpSessionImportError(input);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function normalizeCwdForScope(value: string): string {
  const replaced = value.trim().replace(/\\+/gu, "/").replace(/\/+/gu, "/");
  const withoutTrailing = replaced.length > 1 ? replaced.replace(/\/+$/u, "") : replaced;
  return withoutTrailing.replace(/^[a-zA-Z]:/u, (drive) => drive.toLowerCase());
}

function cwdMatchesScope(sessionCwd: string, requestedCwd: string): boolean {
  return normalizeCwdForScope(sessionCwd) === normalizeCwdForScope(requestedCwd);
}

function assertAbsoluteCwd(input: {
  readonly operation: "list" | "import";
  readonly providerInstanceId: CustomAcpSessionListInput["providerInstanceId"];
  readonly cwd: string;
}) {
  if (isAbsolutePath(input.cwd)) {
    return Effect.void;
  }
  return Effect.fail(
    importError({
      operation: input.operation,
      providerInstanceId: input.providerInstanceId,
      reason: "Custom ACP session import requires an absolute project cwd.",
    }),
  );
}

const mapProviderSessionStatusToOrchestrationStatus = (
  status: ProviderSession["status"],
): "starting" | "ready" | "running" | "error" | "stopped" => {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
};

function resumeCursorSessionId(cursor: unknown): string | undefined {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return undefined;
  }
  const value = (cursor as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:custom-acp-session-import:${tag}:${crypto.randomUUID()}`);

const resolveCustomAcpSettings = (input: {
  readonly providerInstanceId: CustomAcpSessionListInput["providerInstanceId"];
  readonly operation: "list" | "import";
}) =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        importError({
          operation: input.operation,
          providerInstanceId: input.providerInstanceId,
          reason: "Failed to read server settings for Custom ACP provider.",
          cause,
        }),
      ),
    );
    const configMap = deriveProviderInstanceConfigMap(settings);
    const providerConfig = configMap[input.providerInstanceId];
    if (!providerConfig) {
      return yield* importError({
        operation: input.operation,
        providerInstanceId: input.providerInstanceId,
        reason: `Provider instance '${input.providerInstanceId}' was not found.`,
      });
    }
    if (providerConfig.driver !== CUSTOM_ACP_DRIVER) {
      return yield* importError({
        operation: input.operation,
        providerInstanceId: input.providerInstanceId,
        reason: `Provider instance '${input.providerInstanceId}' is not a Custom ACP provider.`,
      });
    }
    if (providerConfig.enabled === false) {
      return yield* importError({
        operation: input.operation,
        providerInstanceId: input.providerInstanceId,
        reason: `Provider instance '${input.providerInstanceId}' is disabled.`,
      });
    }
    const customSettings = yield* decodeCustomAcpSettings(providerConfig.config ?? {}).pipe(
      Effect.mapError((cause) =>
        importError({
          operation: input.operation,
          providerInstanceId: input.providerInstanceId,
          reason: `Provider instance '${input.providerInstanceId}' has invalid Custom ACP settings.`,
          cause,
        }),
      ),
    );
    if (!customSettings.command.trim()) {
      return yield* importError({
        operation: input.operation,
        providerInstanceId: input.providerInstanceId,
        reason: `Provider instance '${input.providerInstanceId}' has no Custom ACP command configured.`,
      });
    }
    return {
      settings: { ...customSettings, enabled: providerConfig.enabled ?? customSettings.enabled },
      environment: mergeProviderInstanceEnvironment(providerConfig.environment),
    };
  });

export const listCustomAcpExternalSessions = (input: CustomAcpSessionListInput) =>
  Effect.gen(function* () {
    yield* assertAbsoluteCwd({
      operation: "list",
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd,
    });
    const { settings, environment } = yield* resolveCustomAcpSettings({
      operation: "list",
      providerInstanceId: input.providerInstanceId,
    });
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const runtime = yield* makeCustomAcpRuntime({
            settings,
            environment,
            childProcessSpawner,
            cwd: input.cwd,
            clientInfo: { name: "t3-code-custom-acp-session-import", version: "0.0.0" },
          });

          const initializePayload = {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              ...buildCustomAcpClientCapabilities(settings),
            },
            clientInfo: { name: "t3-code-custom-acp-session-import", version: "0.0.0" },
          } satisfies EffectAcpSchema.InitializeRequest;
          const initializeResult = yield* runtime
            .request("initialize", initializePayload)
            .pipe(Effect.flatMap(decodeInitializeResponse));

          const authMethodId = normalizeCustomAcpAuthMethodId(settings.authMethodId);
          if (authMethodId) {
            yield* runtime.request("authenticate", { methodId: authMethodId });
          }

          if (!initializeResult.agentCapabilities?.sessionCapabilities?.list) {
            return yield* importError({
              operation: "list",
              providerInstanceId: input.providerInstanceId,
              reason: "Custom ACP agent does not support session/list.",
            });
          }

          const response = yield* runtime
            .request("session/list", { cwd: input.cwd, cursor: input.cursor ?? undefined })
            .pipe(Effect.flatMap(decodeListSessionsResponse));

          return {
            providerInstanceId: input.providerInstanceId,
            sessions: response.sessions.flatMap((session) => {
              const sessionId = session.sessionId.trim();
              const cwd = session.cwd.trim();
              if (!sessionId || !cwd || !cwdMatchesScope(cwd, input.cwd)) {
                return [];
              }
              return [
                {
                  sessionId,
                  cwd,
                  title: session.title?.trim() || null,
                  updatedAt: session.updatedAt?.trim() || null,
                },
              ];
            }),
            nextCursor: response.nextCursor?.trim() || null,
          } satisfies CustomAcpSessionListResult;
        }).pipe(Effect.timeoutOption(CUSTOM_ACP_SESSION_LIST_TIMEOUT_MS));

        return yield* Option.match(result, {
          onNone: () =>
            Effect.fail(
              importError({
                operation: "list",
                providerInstanceId: input.providerInstanceId,
                reason: "Custom ACP session listing timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        });
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isCustomAcpSessionImportError(cause)
          ? cause
          : importError({
              operation: "list",
              providerInstanceId: input.providerInstanceId,
              reason:
                cause instanceof Error ? cause.message : "Failed to list Custom ACP sessions.",
              cause,
            }),
      ),
    );
  });

export const importCustomAcpExternalSession = (input: CustomAcpSessionImportInput) =>
  Effect.gen(function* () {
    yield* assertAbsoluteCwd({
      operation: "import",
      providerInstanceId: input.providerInstanceId,
      cwd: input.cwd,
    });
    yield* resolveCustomAcpSettings({
      operation: "import",
      providerInstanceId: input.providerInstanceId,
    });
    const providerService = yield* Effect.service(ProviderService) as Effect.Effect<
      ProviderServiceShape,
      never,
      never
    >;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const now = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(`thread-${crypto.randomUUID()}`);
    const title = input.title?.trim() || "Imported ACP session";

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: serverCommandId("thread-create"),
      threadId,
      projectId: input.projectId,
      title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });

    const cleanupThread = orchestrationEngine
      .dispatch({
        type: "thread.delete",
        commandId: serverCommandId("thread-delete-cleanup"),
        threadId,
      })
      .pipe(Effect.ignore);

    const session = yield* providerService
      .startSession(threadId, {
        threadId,
        providerInstanceId: input.providerInstanceId,
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        resumeCursor: {
          schemaVersion: 1,
          provider: "customAcp",
          sessionId: input.sessionId,
          requireSessionLoad: true,
        },
      })
      .pipe(
        Effect.tapError(() => cleanupThread),
        Effect.mapError((cause) =>
          importError({
            operation: "import",
            providerInstanceId: input.providerInstanceId,
            reason:
              "Failed to load the selected Custom ACP session; the created thread was removed.",
            cause,
          }),
        ),
      );

    if (resumeCursorSessionId(session.resumeCursor) !== input.sessionId) {
      yield* providerService.stopSession({ threadId }).pipe(Effect.ignore);
      yield* cleanupThread;
      return yield* importError({
        operation: "import",
        providerInstanceId: input.providerInstanceId,
        reason:
          "Custom ACP session/load did not resume the selected session; the created thread was removed.",
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("thread-session-set"),
      threadId,
      session: {
        threadId,
        status: mapProviderSessionStatusToOrchestrationStatus(session.status),
        providerName: session.provider,
        providerInstanceId: session.providerInstanceId,
        runtimeMode: session.runtimeMode,
        activeTurnId: null,
        lastError: session.lastError ?? null,
        updatedAt: session.updatedAt,
      },
      createdAt: now,
    });

    const appendResult = yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("thread-activity-append"),
      threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "info",
        kind: "custom-acp.session.imported",
        summary: `Imported ACP session ${title}. Previous transcript is not copied; future turns continue the external agent session.`,
        payload: {
          providerInstanceId: input.providerInstanceId,
          sessionId: input.sessionId,
          cwd: input.cwd,
          title,
          updatedAt: input.updatedAt ?? null,
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });

    return { threadId, sequence: appendResult.sequence } satisfies CustomAcpSessionImportResult;
  }).pipe(
    Effect.mapError((cause) =>
      isCustomAcpSessionImportError(cause)
        ? cause
        : importError({
            operation: "import",
            providerInstanceId: input.providerInstanceId,
            reason: cause instanceof Error ? cause.message : "Failed to import Custom ACP session.",
            cause,
          }),
    ),
  );
