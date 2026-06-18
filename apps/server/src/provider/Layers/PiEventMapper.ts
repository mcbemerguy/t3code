// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/* oxlint-disable typescript/no-this-alias */
import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PiRpcEvent, PiRpcRuntimeMessage } from "./PiSessionRuntime.ts";
import {
  cancellationResponse,
  cancellationResponseForUnsupportedExtensionUiRequest,
  describeFireAndForgetExtensionUiEvent,
  isPiExtensionUiRequest,
  parsePiExtensionUiDialogRequest,
  questionFromPiExtensionUiDialog,
  toUserInputQuestion,
} from "./PiExtensionUi.ts";
import {
  buildToolEndPresentation,
  buildToolLifecyclePresentation,
  captureEditSnapshot,
  toPiToolItemType,
  toolResultToText,
} from "./PiToolPresentation.ts";
import { isTerminalWorkflowRecord, runCursorFromWorkflowRecord } from "./PiWorkflowArtifacts.ts";
import { mergeWorkflowRunCursor } from "./PiWorkflowCursor.ts";
import { PiWorkflowEventMapper } from "./PiWorkflowMapper.ts";
import type {
  PiAdapterSessionContext,
  PiRuntimeEventOffer,
  PiTurnCompleter,
  PiUsageRefreshScheduler,
} from "./PiAdapterTypes.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const MAX_RETAINED_COMPLETED_PROMPTS = 1024;

export function basePiEvent(
  session: PiAdapterSessionContext,
  input?: {
    readonly raw?: PiRpcRuntimeMessage;
    readonly itemId?: RuntimeItemId;
    readonly requestId?: RuntimeRequestId;
    readonly turnId?: TurnId;
  },
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const raw = input?.raw;
  const rawPayload = raw?.kind === "event" || raw?.kind === "response" ? raw.payload : raw?.line;
  const method =
    raw?.kind === "event"
      ? readPiEventType(raw.payload)
      : raw?.kind === "response"
        ? raw.payload.command
        : raw?.kind === "prelude"
          ? "prelude"
          : undefined;
  const turnId = input?.turnId ?? session.currentTurnId;
  return {
    eventId: EventId.make(`pi-${randomUUID()}`),
    provider: PROVIDER,
    threadId: session.threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
    ...(input?.itemId ? { itemId: input.itemId } : {}),
    ...(input?.requestId ? { requestId: input.requestId } : {}),
    raw: {
      source: raw?.kind === "response" ? "pi.rpc.response" : "pi.rpc.event",
      ...(method ? { method } : {}),
      payload: rawPayload ?? {},
    },
  };
}

export class PiEventMapper {
  private readonly offer: PiRuntimeEventOffer;
  private readonly scheduleUsageRefresh: PiUsageRefreshScheduler;
  private readonly completeTurn: PiTurnCompleter;

  constructor(
    offer: PiRuntimeEventOffer,
    scheduleUsageRefresh: PiUsageRefreshScheduler,
    completeTurn: PiTurnCompleter,
  ) {
    this.offer = offer;
    this.scheduleUsageRefresh = scheduleUsageRefresh;
    this.completeTurn = completeTurn;
  }

  handle = (
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage,
  ): Effect.Effect<void> => {
    const self = this;
    return Effect.gen(function* () {
      if (message.kind === "event") return yield* self.handleEvent(session, message);
      if (message.kind === "response" && !message.payload.success) {
        yield* self.offer([
          {
            ...basePiEvent(session, { raw: message }),
            type: "runtime.error",
            payload: {
              message: message.payload.error ?? `Pi RPC ${message.payload.command} failed`,
              class: "provider_error",
              detail: message.payload,
            },
          } satisfies ProviderRuntimeEvent,
        ]);
        if (message.payload.command === "prompt" && !session.turnCompleted) {
          yield* self.completeTurn(session, message, "failed", {
            errorMessage: message.payload.error ?? "Pi prompt failed.",
          });
        }
        return;
      }
      if (message.kind === "prelude") {
        yield* self.offer([
          {
            ...basePiEvent(session, { raw: message }),
            type: "runtime.warning",
            payload: { message: message.line },
          } satisfies ProviderRuntimeEvent,
        ]);
      }
    });
  };

  private handleEvent(
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage & { readonly kind: "event" },
  ) {
    const self = this;
    return Effect.gen(function* () {
      const event = message.payload;
      const type = readPiEventType(event);

      if (isWorkflowArtifactEvent(event)) {
        const cursor = runCursorFromWorkflowRecord(event);
        const terminal = isTerminalWorkflowRecord(event);
        if (cursor) {
          const previous = session.workflowRuns.get(cursor.runId);
          if (previous && cursor.lastSequence > 0 && cursor.lastSequence <= previous.lastSequence)
            return;
          const turnId = session.currentTurnId ?? session.latestTurnId;
          if (turnId && !session.workflowRunTurnIds.has(cursor.runId)) {
            session.workflowRunTurnIds.set(cursor.runId, turnId);
          }
          if (terminal) {
            session.workflowRuns.delete(cursor.runId);
            session.workflowTails.delete(cursor.runId);
          } else session.workflowRuns.set(cursor.runId, mergeWorkflowRunCursor(previous, cursor));
        }
        const workflowMapper = session.workflowMapper ?? new PiWorkflowEventMapper();
        session.workflowMapper = workflowMapper;
        const events = workflowMapper.map(session, event);
        if (events.length > 0) yield* self.offer(events);
        if (cursor && terminal) {
          const turnId = session.workflowRunTurnIds.get(cursor.runId);
          if (turnId && session.currentTurnId === turnId && !session.turnCompleted) {
            const failed = workflowRecordFailed(event);
            const errorMessage = workflowRecordError(event);
            yield* self.completeTurn(
              session,
              message,
              failed ? "failed" : "completed",
              failed && errorMessage ? { errorMessage } : {},
            );
          }
          session.workflowRunTurnIds.delete(cursor.runId);
        }
        if (type === "context_usage_update") yield* self.scheduleUsageRefresh(session);
        return;
      }

      if (isPiExtensionUiRequest(event)) {
        return yield* self.handleExtensionUiRequest(session, message, event);
      }

      if (type === "prompt_start" || type === "agent_start") {
        if (session.turnCompleted || !session.currentTurnId) return;
        if (
          session.requirePromptStartBeforeCompletion &&
          (!session.promptAccepted || session.quarantinePromptEventsUntilAcceptedDrain)
        ) {
          retainCompletedPromptEventId(session, event);
          return;
        }
        const lifecycleId = lifecycleEventId(event);
        if (lifecycleId) {
          if (session.completedPromptEventIds.has(lifecycleId)) return;
          session.activePromptEventId = lifecycleId;
        }
        session.requirePromptStartBeforeCompletion = false;
        return yield* self.offer([
          {
            ...basePiEvent(session, { raw: message }),
            type: "session.state.changed",
            payload: { state: "running" },
          } satisfies ProviderRuntimeEvent,
        ]);
      }

      if (session.requirePromptStartBeforeCompletion) {
        retainCompletedPromptEventId(session, event);
        return;
      }

      const textDelta = assistantDelta(event);
      if (textDelta !== undefined)
        return yield* self.emitAssistantDelta(session, message, textDelta);
      if (isReasoningStart(event)) return yield* self.ensureReasoningItem(session, message);
      const thoughtDelta = reasoningDelta(event);
      if (thoughtDelta !== undefined)
        return yield* self.emitReasoningDelta(session, message, thoughtDelta);
      if (isReasoningEnd(event)) return yield* self.completeReasoningItem(session, message);
      if (type === "message_start" && messageRole(event) === "assistant")
        return yield* self.ensureAssistantItem(session, message);

      if (type === "message_end") {
        const finalText = extractAssistantFinalText(event);
        if (finalText) {
          const streamed = session.assistantItemText ?? "";
          const missing = !streamed
            ? finalText
            : finalText.startsWith(streamed)
              ? finalText.slice(streamed.length)
              : finalText === streamed
                ? ""
                : finalText;
          if (missing) yield* self.emitAssistantDelta(session, message, missing);
        }
        if (messageRole(event) === "assistant") yield* self.completeAssistantItem(session, message);
        return yield* self.scheduleUsageRefresh(session);
      }

      if (type === "tool_execution_start") return yield* self.toolStart(session, message, event);
      if (type === "tool_execution_update") return yield* self.toolUpdate(session, message, event);
      if (type === "tool_execution_end") return yield* self.toolEnd(session, message, event);

      if (
        type === "auto_retry_start" ||
        type === "auto_compaction_start" ||
        type === "auto_compaction_end"
      ) {
        const text =
          type === "auto_retry_start"
            ? "Pi is retrying the request."
            : type === "auto_compaction_start"
              ? "Context nearing limit, running automatic compaction..."
              : "Automatic compaction finished; context was summarized to continue the session.";
        yield* self.emitAssistantDelta(session, message, text);
        return yield* self.scheduleUsageRefresh(
          session,
          type === "auto_compaction_end" ? { contextChange: "compaction" } : undefined,
          type === "auto_compaction_end",
        );
      }

      if (type === "prompt_end" || type === "agent_end") {
        if (event.willRetry === true) return;
        const lifecycleId = lifecycleEventId(event);
        if (lifecycleId && session.completedPromptEventIds.has(lifecycleId)) return;
        if (
          lifecycleId &&
          session.activePromptEventId &&
          lifecycleId !== session.activePromptEventId
        )
          return;
        if (session.turnCompleted || !session.currentTurnId) return;
        const state =
          event.success === false || trimText(event.stopReason) === "error"
            ? "failed"
            : trimText(event.stopReason) === "cancelled"
              ? "cancelled"
              : "completed";
        yield* self.completeAssistantItem(session, message);
        yield* self.completeReasoningItem(session, message);
        yield* self.completeTurn(session, message, state);
        yield* self.scheduleUsageRefresh(session, undefined, true);
      }
    });
  }

  private handleExtensionUiRequest(
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage & { readonly kind: "event" },
    event: PiRpcEvent,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const request = parsePiExtensionUiDialogRequest(event, message);
      if (session.nextTurnRequiresPromptStart || session.requirePromptStartBeforeCompletion) {
        const response = request
          ? cancellationResponse(request)
          : cancellationResponseForUnsupportedExtensionUiRequest(event);
        if (response) yield* session.runtime.respondExtensionUi(response).pipe(Effect.ignore);
        return;
      }
      const pending = request ? questionFromPiExtensionUiDialog(request) : undefined;
      if (!pending) {
        const response = request
          ? cancellationResponse(request)
          : cancellationResponseForUnsupportedExtensionUiRequest(event);
        if (response) {
          yield* session.runtime.respondExtensionUi(response).pipe(Effect.ignore);
        }
        const detail = describeFireAndForgetExtensionUiEvent(event);
        if (detail) {
          yield* self.offer([
            {
              ...basePiEvent(session, { raw: message }),
              type: "runtime.warning",
              payload: { message: detail, detail: event },
            } satisfies ProviderRuntimeEvent,
          ]);
        }
        return;
      }

      session.pendingUserInputs.set(pending.requestId, pending);
      yield* self.offer([
        {
          ...basePiEvent(session, { raw: message, requestId: pending.requestId }),
          type: "user-input.requested",
          payload: { questions: [toUserInputQuestion(pending)] },
        } satisfies ProviderRuntimeEvent,
      ]);
    });
  }

  private emitAssistantDelta(
    session: PiAdapterSessionContext,
    raw: PiRpcRuntimeMessage,
    delta: string,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const itemId = yield* self.ensureAssistantItem(session, raw);
      session.assistantItemText = `${session.assistantItemText ?? ""}${delta}`;
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta },
        } satisfies ProviderRuntimeEvent,
      ]);
    });
  }

  private emitReasoningDelta(
    session: PiAdapterSessionContext,
    raw: PiRpcRuntimeMessage,
    delta: string,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const itemId = yield* self.ensureReasoningItem(session, raw);
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "content.delta",
          payload: { streamKind: "reasoning_text", delta },
        } satisfies ProviderRuntimeEvent,
      ]);
    });
  }

  private ensureAssistantItem(session: PiAdapterSessionContext, raw: PiRpcRuntimeMessage) {
    const self = this;
    return Effect.gen(function* () {
      if (session.assistantItemId) return session.assistantItemId;
      const itemId = runtimeItemId(`pi-assistant-${randomUUID()}`);
      session.assistantItemId = itemId;
      session.assistantItemText = "";
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
        } satisfies ProviderRuntimeEvent,
      ]);
      return itemId;
    });
  }

  private completeAssistantItem(session: PiAdapterSessionContext, raw: PiRpcRuntimeMessage) {
    const self = this;
    return Effect.gen(function* () {
      const itemId = session.assistantItemId;
      if (!itemId) return;
      delete session.assistantItemId;
      delete session.assistantItemText;
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed", title: "Assistant" },
        } satisfies ProviderRuntimeEvent,
      ]);
    });
  }

  private ensureReasoningItem(session: PiAdapterSessionContext, raw: PiRpcRuntimeMessage) {
    const self = this;
    return Effect.gen(function* () {
      if (session.reasoningItemId) return session.reasoningItemId;
      const itemId = runtimeItemId(`pi-reasoning-${randomUUID()}`);
      session.reasoningItemId = itemId;
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "item.started",
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
        } satisfies ProviderRuntimeEvent,
      ]);
      return itemId;
    });
  }

  private completeReasoningItem(session: PiAdapterSessionContext, raw: PiRpcRuntimeMessage) {
    const self = this;
    return Effect.gen(function* () {
      const itemId = session.reasoningItemId;
      if (!itemId) return;
      delete session.reasoningItemId;
      yield* self.offer([
        {
          ...basePiEvent(session, { raw, itemId }),
          type: "item.completed",
          payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
        } satisfies ProviderRuntimeEvent,
      ]);
      yield* self.scheduleUsageRefresh(session);
    });
  }

  private toolStart(
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage & { readonly kind: "event" },
    event: PiRpcEvent,
  ) {
    const id = toolCallId(event);
    const name = toolName(event);
    const itemId = runtimeItemId(`pi-tool-${id}`);
    const presentation = buildToolLifecyclePresentation({
      toolName: name,
      toolCallId: id,
      args: event.args,
    });
    const snapshot = captureEditSnapshot(name, event.args, session.cwd);
    const turnId = latestPiTurnId(session);
    session.tools.set(id, {
      toolName: name,
      itemId,
      ...(turnId ? { turnId } : {}),
      updates: [],
      presentation,
      ...(snapshot ? { snapshot } : {}),
    });
    return this.offer([
      {
        ...basePiEvent(session, toolEventInput(message, itemId, turnId)),
        type: "item.started",
        payload: {
          itemType: presentation.itemType,
          status: "inProgress",
          title: presentation.title,
          ...(presentation.detail ? { detail: presentation.detail } : {}),
          data: presentation.data,
        },
      } satisfies ProviderRuntimeEvent,
    ]);
  }

  private toolUpdate(
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage & { readonly kind: "event" },
    event: PiRpcEvent,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const id = trimText(event.toolCallId) ?? trimText(event.id);
      if (!id) return;
      const state = session.tools.get(id);
      if (!state) return;
      if (event.partialResult !== undefined) state.updates.push(event.partialResult);
      if (event.update !== undefined) state.updates.push(event.update);
      const updateText = toolResultToText(event.partialResult ?? event.update);
      const events: Array<ProviderRuntimeEvent> = [];
      if (updateText) {
        events.push({
          ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
          type: "content.delta",
          payload: { streamKind: "command_output", delta: updateText },
        } satisfies ProviderRuntimeEvent);
      }
      events.push({
        ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
        type: "item.updated",
        payload: {
          itemType: state.presentation.itemType,
          status: "inProgress",
          title: state.presentation.title,
          ...(state.presentation.detail ? { detail: state.presentation.detail } : {}),
          data: {
            ...state.presentation.data,
            ...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
            ...(event.update !== undefined ? { update: event.update } : {}),
          },
        },
      } satisfies ProviderRuntimeEvent);
      yield* self.offer(events);
      yield* self.scheduleUsageRefresh(session);
    });
  }

  private toolEnd(
    session: PiAdapterSessionContext,
    message: PiRpcRuntimeMessage & { readonly kind: "event" },
    event: PiRpcEvent,
  ) {
    const self = this;
    return Effect.gen(function* () {
      const id = trimText(event.toolCallId) ?? trimText(event.id);
      if (!id) return;
      const fallbackToolName = toolName(event);
      const fallbackTurnId = latestPiTurnId(session);
      const state = session.tools.get(id) ?? {
        toolName: fallbackToolName,
        itemId: runtimeItemId(`pi-tool-${id}`),
        ...(fallbackTurnId ? { turnId: fallbackTurnId } : {}),
        updates: [],
        presentation: buildToolLifecyclePresentation({
          toolName: fallbackToolName,
          toolCallId: id,
          args: event.args,
        }),
      };
      const presentation = buildToolEndPresentation({
        cwd: session.cwd,
        result: event.result,
        updates: state.updates,
        ...(state.snapshot ? { snapshot: state.snapshot } : {}),
      });
      const events: Array<ProviderRuntimeEvent> = [];
      if (presentation.diagnostic)
        events.push({
          ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
          type: "content.delta",
          payload: { streamKind: "file_change_output", delta: presentation.diagnostic },
        } satisfies ProviderRuntimeEvent);
      if (presentation.outputText)
        events.push({
          ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
          type: "content.delta",
          payload: {
            streamKind:
              toPiToolItemType(state.toolName) === "file_change"
                ? "file_change_output"
                : "command_output",
            delta: presentation.outputText,
          },
        } satisfies ProviderRuntimeEvent);
      if (presentation.unifiedDiff)
        events.push({
          ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
          type: "turn.diff.updated",
          payload: { unifiedDiff: presentation.unifiedDiff },
        } satisfies ProviderRuntimeEvent);
      events.push({
        ...basePiEvent(session, toolEventInput(message, state.itemId, state.turnId)),
        type: "item.completed",
        payload: {
          itemType: state.presentation.itemType,
          status: event.isError === true ? "failed" : "completed",
          title: state.presentation.title,
          ...(state.presentation.detail ? { detail: state.presentation.detail } : {}),
          data: mergeToolCompletionData(state.presentation.data, event.result),
        },
      } satisfies ProviderRuntimeEvent);
      session.tools.delete(id);
      yield* self.offer(events);
      yield* self.scheduleUsageRefresh(session);
    });
  }
}

function latestPiTurnId(session: PiAdapterSessionContext): TurnId | undefined {
  return session.currentTurnId ?? session.latestTurnId;
}

function toolEventInput(
  raw: PiRpcRuntimeMessage,
  itemId: RuntimeItemId,
  turnId: TurnId | undefined,
): { readonly raw: PiRpcRuntimeMessage; readonly itemId: RuntimeItemId; readonly turnId?: TurnId } {
  return { raw, itemId, ...(turnId ? { turnId } : {}) };
}

function mergeToolCompletionData(metadata: object, result: unknown): object {
  if (result === undefined) return metadata;
  const resultFields =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  return { ...resultFields, ...metadata, result };
}

function runtimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value.replace(/[^A-Za-z0-9_.:-]/g, "-"));
}

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPiEventType(event: PiRpcEvent): string {
  return trimText(event.type) ?? "event";
}

function lifecycleEventId(event: PiRpcEvent): string | undefined {
  return trimText(event.id) ?? trimText(event.promptId) ?? trimText(event.requestId);
}

function retainCompletedPromptEventId(session: PiAdapterSessionContext, event: PiRpcEvent): void {
  const id = lifecycleEventId(event);
  if (!id) return;
  session.completedPromptEventIds.add(id);
  while (session.completedPromptEventIds.size > MAX_RETAINED_COMPLETED_PROMPTS) {
    const oldest = session.completedPromptEventIds.keys().next();
    if (oldest.done) return;
    session.completedPromptEventIds.delete(oldest.value);
  }
}

function toolCallId(event: PiRpcEvent): string {
  return trimText(event.toolCallId) ?? trimText(event.id) ?? `tool-${randomUUID()}`;
}

function toolName(event: PiRpcEvent): string {
  return trimText(event.toolName) ?? trimText(event.name) ?? "tool";
}

function isWorkflowArtifactEvent(event: PiRpcEvent): boolean {
  const type = readPiEventType(event);
  return (
    trimText(event.runId) !== undefined &&
    (type === "run_start" ||
      type === "run_end" ||
      type === "run_paused" ||
      type === "run_interrupted" ||
      type === "run_resume_requested" ||
      type === "step_start" ||
      type === "step_update" ||
      type === "step_end" ||
      type === "inline_subworkflow_start" ||
      type === "inline_subworkflow_end" ||
      type === "subworkflow_call_start" ||
      type === "subworkflow_call_end" ||
      type === "child_pi_event" ||
      type === "context_usage_update")
  );
}

function workflowRecordFailed(event: PiRpcEvent): boolean {
  const status = trimText(event.status)?.toLowerCase();
  return status === "failed" || status === "aborted" || Boolean(trimText(event.error));
}

function workflowRecordError(event: PiRpcEvent): string | undefined {
  return trimText(event.error) ?? trimText(event.message);
}

function assistantMessageEvent(event: PiRpcEvent): Record<string, unknown> | undefined {
  return readRecord(event.assistantMessageEvent) ?? readRecord(event.messageEvent);
}

function assistantDelta(event: PiRpcEvent): string | undefined {
  const type = readPiEventType(event);
  if (type === "assistant_delta" || type === "text_delta")
    return textPayload(event.delta) ?? textPayload(event.text);
  const nested = assistantMessageEvent(event);
  const nestedType = trimText(nested?.type);
  return nestedType === "text_delta" || nestedType === "assistant_delta"
    ? (textPayload(nested?.delta) ?? textPayload(nested?.text))
    : undefined;
}

function reasoningDelta(event: PiRpcEvent): string | undefined {
  const type = readPiEventType(event);
  if (type === "thought_delta" || type === "reasoning_delta" || type === "thinking_delta")
    return textPayload(event.delta) ?? textPayload(event.text);
  const nested = assistantMessageEvent(event);
  const nestedType = trimText(nested?.type);
  return nestedType === "thinking_delta" ||
    nestedType === "thought_delta" ||
    nestedType === "reasoning_delta"
    ? (textPayload(nested?.delta) ?? textPayload(nested?.text))
    : undefined;
}

function isReasoningStart(event: PiRpcEvent): boolean {
  return (
    readPiEventType(event) === "thought_start" ||
    trimText(assistantMessageEvent(event)?.type) === "thinking_start"
  );
}

function isReasoningEnd(event: PiRpcEvent): boolean {
  return (
    readPiEventType(event) === "thought_end" ||
    trimText(assistantMessageEvent(event)?.type) === "thinking_end"
  );
}

function messageRole(event: PiRpcEvent): string | undefined {
  return trimText(readRecord(event.message)?.role);
}

function extractAssistantFinalText(event: PiRpcEvent): string | undefined {
  const message = readRecord(event.message);
  if (messageRole(event) !== "assistant") return undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => {
      const record = readRecord(entry);
      return record?.type === "text" ? (textPayload(record.text) ?? "") : "";
    })
    .join("");
  return text || undefined;
}
