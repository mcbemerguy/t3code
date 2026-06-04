#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics runEffectInsideEffect:off
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitSubagentToolCall = process.env.T3_ACP_EMIT_SUBAGENT_TOOL_CALL === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitAvailableCommands = process.env.T3_ACP_EMIT_AVAILABLE_COMMANDS === "1";
const emitAvailableCommandsOnPrompt = process.env.T3_ACP_EMIT_AVAILABLE_COMMANDS_ON_PROMPT === "1";
const omitModelConfig = process.env.T3_ACP_OMIT_MODEL_CONFIG === "1";
const emitThoughtLevelConfig = process.env.T3_ACP_EMIT_THOUGHT_LEVEL_CONFIG === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const failPromptDetail = process.env.T3_ACP_FAIL_PROMPT_DETAIL ?? "Mock prompt failed";
const enableSessionList = process.env.T3_ACP_ENABLE_SESSION_LIST === "1";
const enableSessionClose = process.env.T3_ACP_ENABLE_SESSION_CLOSE === "1";
const enableSessionDelete = process.env.T3_ACP_ENABLE_SESSION_DELETE === "1";
const failSessionClose = process.env.T3_ACP_FAIL_SESSION_CLOSE === "1";
const failSessionDelete = process.env.T3_ACP_FAIL_SESSION_DELETE === "1";
const enablePiSteering = process.env.T3_ACP_ENABLE_PI_STEERING === "1";
const enablePiWorkflows = process.env.T3_ACP_ENABLE_PI_WORKFLOWS === "1";
const emitWorkflowReplayOnLoad = process.env.T3_ACP_EMIT_WORKFLOW_REPLAY_ON_LOAD === "1";
const workflowReplaySequence =
  parseNonNegativeIntOrZero(process.env.T3_ACP_WORKFLOW_REPLAY_SEQUENCE) || 1;
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
const failCreateSessionCount = parseNonNegativeIntOrZero(
  process.env.T3_ACP_FAIL_CREATE_SESSION_COUNT,
);
let statelessFailCreateSessionAttempts = 0;
const failCreateSessionStatePath = process.env.T3_ACP_FAIL_CREATE_SESSION_STATE_PATH;
const failCreateSessionDetail =
  process.env.T3_ACP_FAIL_CREATE_SESSION_DETAIL ?? "Mock failed session/new during startup";
const failPromptAfterCancel = process.env.T3_ACP_FAIL_PROMPT_AFTER_CANCEL === "1";
const hangCancel = process.env.T3_ACP_HANG_CANCEL === "1";
const hangPrompt = process.env.T3_ACP_HANG_PROMPT === "1";
const hangPromptAfterCancel = process.env.T3_ACP_HANG_PROMPT_AFTER_CANCEL === "1";
const promptStopReasonCancelled = process.env.T3_ACP_PROMPT_STOP_REASON_CANCELLED === "1";
const listExtraCwd = process.env.T3_ACP_LIST_EXTRA_CWD;
const sessionId = "mock-session-1";

let currentModeId = "ask";
let currentModelId = "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
const cancelledSessions = new Set<string>();

function parseNonNegativeIntOrZero(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function readCreateSessionFailureAttempts(): number {
  if (!failCreateSessionStatePath || !existsSync(failCreateSessionStatePath)) return 0;
  const raw = readFileSync(failCreateSessionStatePath, "utf8").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function shouldFailCreateSession(): boolean {
  if (failCreateSessionCount <= 0) return false;
  if (!failCreateSessionStatePath) {
    statelessFailCreateSessionAttempts++;
    return statelessFailCreateSessionAttempts <= failCreateSessionCount;
  }
  const attempts = readCreateSessionFailureAttempts();
  writeFileSync(failCreateSessionStatePath, String(attempts + 1), "utf8");
  return attempts < failCreateSessionCount;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function maybeOmitModelConfig(
  options: ReadonlyArray<AcpSchema.SessionConfigOption>,
): ReadonlyArray<AcpSchema.SessionConfigOption> {
  return omitModelConfig ? options.filter((option) => option.category !== "model") : options;
}

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return maybeOmitModelConfig([
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ]);
      case "composer-2":
        return maybeOmitModelConfig([
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ]);
      case "claude-opus-4-6":
        return maybeOmitModelConfig([
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ]);
      default:
        return maybeOmitModelConfig(baseOptions);
    }
  }

  const baseOptions: Array<AcpSchema.SessionConfigOption> = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];

  return maybeOmitModelConfig([
    ...baseOptions,
    ...(emitThoughtLevelConfig
      ? [
          {
            id: "thought_level",
            name: "Thinking level",
            category: "thought_level",
            type: "select" as const,
            currentValue: currentReasoning,
            options: [
              { value: "off", name: "Off" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ]
      : []),
  ]);
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

function availableCommands(): ReadonlyArray<AcpSchema.AvailableCommand> {
  return [
    {
      name: "/mock",
      description: "Run a mock command",
      input: { hint: "optional input" },
    },
    {
      name: "Mock",
      description: "Duplicate ignored",
    },
  ];
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize((request) =>
    Effect.sync(() => {
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(enableSessionList || enableSessionClose || enableSessionDelete
            ? {
                sessionCapabilities: {
                  ...(enableSessionList ? { list: {} } : {}),
                  ...(enableSessionClose ? { close: {} } : {}),
                  ...(enableSessionDelete ? { delete: {} } : {}),
                },
              }
            : {}),
          ...(enablePiSteering || enablePiWorkflows || enableSessionDelete
            ? {
                _meta: {
                  piAcp: {
                    ...(enableSessionDelete ? { sessionDelete: true } : {}),
                    ...(enablePiSteering ? { steering: true, steeringMethod: "_pi/steer" } : {}),
                    ...(enablePiWorkflows
                      ? {
                          workflows: true,
                          workflowMethods: [
                            "_pi/workflows/list",
                            "_pi/workflows/get",
                            "_pi/workflows/events",
                            "_pi/workflows/resume",
                            "_pi/workflows/interrupt",
                            "_pi/workflows/pause",
                            "_pi/workflows/abort",
                          ],
                          workflowEventsMethod: "_pi/workflows/events",
                        }
                      : {}),
                  },
                },
              }
            : {}),
        },
      };
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      if (shouldFailCreateSession()) {
        return yield* AcpError.AcpRequestError.internalError(failCreateSessionDetail, {
          method: "session/new",
        });
      }
      return yield* Effect.sync(() => {
        if (emitAvailableCommands) {
          queueMicrotask(() => {
            Effect.runFork(
              agent.client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: "available_commands_update",
                  availableCommands: availableCommands(),
                },
              }),
            );
          });
        }
        return {
          sessionId,
          modes: modeState(),
          configOptions: configOptions(),
        };
      });
    }),
  );

  yield* agent.handleListSessions((request) =>
    Effect.succeed({
      sessions: [
        {
          sessionId: "external-session-1",
          cwd: request.cwd ?? process.cwd(),
          title: "External session",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
        ...(listExtraCwd
          ? [
              {
                sessionId: "external-session-outside-cwd",
                cwd: listExtraCwd,
                title: "Outside cwd session",
                updatedAt: "2026-05-22T00:00:00.000Z",
              },
            ]
          : []),
      ],
      nextCursor: request.cursor ? null : "next-page",
    }),
  );

  yield* agent.handleLoadSession((request) =>
    failLoadSession
      ? Effect.fail(
          AcpError.AcpRequestError.invalidParams("Mock failed session/load", {
            method: "session/load",
          }),
        )
      : Effect.gen(function* () {
          const requestedSessionId = String(request.sessionId ?? sessionId);
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "replay" },
            },
          });
          if (emitWorkflowReplayOnLoad) {
            yield* agent.client.extNotification("_pi/workflows/events", {
              sessionId: requestedSessionId,
              runId: "workflow-run-1",
              sequence: workflowReplaySequence,
              event: {
                type: "run_start",
                runId: "workflow-run-1",
                sequence: workflowReplaySequence,
                workflowId: "mock-workflow",
                runDir: "/tmp/workflow-run-1",
                auditPath: "/tmp/workflow-run-1/audit.md",
                status: "running",
              },
            });
            yield* agent.client.sessionUpdate({
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "workflow:workflow-run-1",
                title: "Workflow: mock-workflow",
                kind: "other",
                status: "in_progress",
                rawInput: { runId: "workflow-run-1" },
                _meta: { piWorkflow: { runId: "workflow-run-1" } },
              },
            } as AcpSchema.SessionNotification);
          }
          return {
            modes: modeState(),
            configOptions: configOptions(),
          };
        }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (
        (request.configId === "reasoning" || request.configId === "thought_level") &&
        typeof request.value === "string"
      ) {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    hangCancel
      ? Effect.never
      : Effect.sync(() => {
          cancelledSessions.add(String(sessionId ?? "mock-session-1"));
        }),
  );

  yield* agent.handleCloseSession((request) =>
    failSessionClose
      ? Effect.fail(
          AcpError.AcpRequestError.internalError("Mock failed session/close", {
            method: "session/close",
            params: request,
          }),
        )
      : Effect.sync(() => {
          cancelledSessions.add(String(request.sessionId ?? "mock-session-1"));
          return {};
        }),
  );

  for (const method of [
    "_pi/workflows/resume",
    "_pi/workflows/interrupt",
    "_pi/workflows/pause",
    "_pi/workflows/abort",
  ] as const) {
    yield* agent.handleExtRequest(method, Schema.Unknown, (params) => {
      const payload =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const runId = typeof payload.runId === "string" ? payload.runId : "workflow-run-1";
      return Effect.succeed({
        run: {
          id: runId,
          runId,
          status:
            method === "_pi/workflows/abort"
              ? "aborted"
              : method === "_pi/workflows/pause"
                ? "paused"
                : method === "_pi/workflows/interrupt"
                  ? "interrupted"
                  : "recovering",
        },
      });
    });
  }

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);

      if (hangPrompt) {
        return yield* Effect.never;
      }

      if (emitAvailableCommandsOnPrompt) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: availableCommands(),
          },
        });
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Internal error", {
          details: failPromptDetail,
          method: "session/prompt",
          params: request,
        });
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permission = yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "`cat server/package.json`",
            kind: "execute",
            status: "pending",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Not in allowlist: cat server/package.json",
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });

        const cancelled =
          cancelledSessions.delete(requestedSessionId) ||
          permission.outcome.outcome === "cancelled";

        if (cancelled && hangPromptAfterCancel) {
          return yield* Effect.never;
        }

        if (cancelled && failPromptAfterCancel) {
          return yield* AcpError.AcpRequestError.invalidParams("Mock prompt failed after cancel", {
            method: "session/prompt",
            params: request,
          });
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled || promptStopReasonCancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitSubagentToolCall) {
        const toolCallId = "tool-call-subagent-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "subagent",
            kind: "other",
            status: "in_progress",
            rawInput: {
              type: "scout",
              tasks: ["find ACP tool code", "find t3code rendering code", "find tests"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "scout results",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return { stopReason: promptStopReasonCancelled ? "cancelled" : "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method.startsWith("_pi/workflows/")) {
      const payload =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const runId = typeof payload.runId === "string" ? payload.runId : "workflow-run-1";
      if (method === "_pi/workflows/list") {
        return Effect.succeed({
          runs: [
            {
              id: runId,
              runId,
              status: "running",
              runDir: "/tmp/workflow-run-1",
              auditPath: "/tmp/workflow-run-1/audit.md",
            },
          ],
        });
      }
      if (method === "_pi/workflows/events") {
        return Effect.succeed({
          events: [],
          nextOffset: 0,
          lastSequence: 1,
          malformedLineCount: 0,
        });
      }
      return Effect.succeed({
        run: {
          id: runId,
          runId,
          status:
            method === "_pi/workflows/abort"
              ? "aborted"
              : method === "_pi/workflows/pause"
                ? "paused"
                : method === "_pi/workflows/interrupt"
                  ? "interrupted"
                  : "recovering",
        },
      });
    }

    if (method === "session/delete") {
      if (!enableSessionDelete) {
        return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
      }
      if (failSessionDelete) {
        return Effect.fail(
          AcpError.AcpRequestError.internalError("Mock failed session/delete", {
            method,
            params,
          }),
        );
      }
      const payload =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      cancelledSessions.add(String(payload.sessionId ?? sessionId));
      return Effect.succeed({});
    }

    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
