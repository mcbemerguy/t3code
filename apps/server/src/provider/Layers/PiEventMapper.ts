// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/* oxlint-disable typescript/no-this-alias */
import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
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
  captureEditSnapshot,
  toPiToolItemType,
  toolResultToText,
} from "./PiToolPresentation.ts";
import type {
  PiAdapterSessionContext,
  PiRuntimeEventOffer,
  PiTurnCompleter,
  PiUsageRefreshScheduler,
} from "./PiAdapterTypes.ts";

const PROVIDER = ProviderDriverKind.make("pi");

export function basePiEvent(
  session: PiAdapterSessionContext,
  input?: {
    readonly raw?: PiRpcRuntimeMessage;
    readonly itemId?: RuntimeItemId;
    readonly requestId?: RuntimeRequestId;
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
  return {
    eventId: EventId.make(`pi-${randomUUID()}`),
    provider: PROVIDER,
    threadId: session.threadId,
    createdAt: new Date().toISOString(),
    ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
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
        return yield* self.offer([
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

      if (isPiExtensionUiRequest(event)) {
        return yield* self.handleExtensionUiRequest(session, message, event);
      }

      if (type === "prompt_start" || type === "agent_start") {
        return yield* self.offer([
          {
            ...basePiEvent(session, { raw: message }),
            type: "session.state.changed",
            payload: { state: "running" },
          } satisfies ProviderRuntimeEvent,
        ]);
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
        if (finalText && !session.assistantItemId)
          yield* self.emitAssistantDelta(session, message, finalText);
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
        return yield* self.scheduleUsageRefresh(session);
      }

      if (type === "prompt_end" || type === "agent_end") {
        if (event.willRetry === true) return;
        const state =
          event.success === false || trimText(event.stopReason) === "error"
            ? "failed"
            : trimText(event.stopReason) === "cancelled"
              ? "cancelled"
              : "completed";
        yield* self.completeAssistantItem(session, message);
        yield* self.completeReasoningItem(session, message);
        yield* self.completeTurn(session, message, state);
        yield* self.scheduleUsageRefresh(session);
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
    const snapshot = captureEditSnapshot(name, event.args, session.cwd);
    session.tools.set(id, {
      toolName: name,
      itemId,
      updates: [],
      ...(snapshot ? { snapshot } : {}),
    });
    return this.offer([
      {
        ...basePiEvent(session, { raw: message, itemId }),
        type: "item.started",
        payload: {
          itemType: toPiToolItemType(name),
          status: "inProgress",
          title: name,
          ...(event.args !== undefined ? { data: { args: event.args } } : {}),
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
      if (!updateText) return;
      yield* self.offer([
        {
          ...basePiEvent(session, { raw: message, itemId: state.itemId }),
          type: "content.delta",
          payload: { streamKind: "command_output", delta: updateText },
        } satisfies ProviderRuntimeEvent,
      ]);
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
      const state = session.tools.get(id) ?? {
        toolName: toolName(event),
        itemId: runtimeItemId(`pi-tool-${id}`),
        updates: [],
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
          ...basePiEvent(session, { raw: message, itemId: state.itemId }),
          type: "content.delta",
          payload: { streamKind: "file_change_output", delta: presentation.diagnostic },
        } satisfies ProviderRuntimeEvent);
      if (presentation.outputText)
        events.push({
          ...basePiEvent(session, { raw: message, itemId: state.itemId }),
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
          ...basePiEvent(session, { raw: message, itemId: state.itemId }),
          type: "turn.diff.updated",
          payload: { unifiedDiff: presentation.unifiedDiff },
        } satisfies ProviderRuntimeEvent);
      events.push({
        ...basePiEvent(session, { raw: message, itemId: state.itemId }),
        type: "item.completed",
        payload: {
          itemType: toPiToolItemType(state.toolName),
          status: event.isError === true ? "failed" : "completed",
          title: state.toolName,
          ...(event.result !== undefined ? { data: event.result } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      session.tools.delete(id);
      yield* self.offer(events);
      yield* self.scheduleUsageRefresh(session);
    });
  }
}

function runtimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value.replace(/[^A-Za-z0-9_.:-]/g, "-"));
}

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPiEventType(event: PiRpcEvent): string {
  return trimText(event.type) ?? "event";
}

function toolCallId(event: PiRpcEvent): string {
  return trimText(event.toolCallId) ?? trimText(event.id) ?? `tool-${randomUUID()}`;
}

function toolName(event: PiRpcEvent): string {
  return trimText(event.toolName) ?? trimText(event.name) ?? "tool";
}

function assistantMessageEvent(event: PiRpcEvent): Record<string, unknown> | undefined {
  return readRecord(event.assistantMessageEvent) ?? readRecord(event.messageEvent);
}

function assistantDelta(event: PiRpcEvent): string | undefined {
  const type = readPiEventType(event);
  if (type === "assistant_delta" || type === "text_delta")
    return trimText(event.delta) ?? trimText(event.text);
  const nested = assistantMessageEvent(event);
  const nestedType = trimText(nested?.type);
  return nestedType === "text_delta" || nestedType === "assistant_delta"
    ? (trimText(nested?.delta) ?? trimText(nested?.text))
    : undefined;
}

function reasoningDelta(event: PiRpcEvent): string | undefined {
  const type = readPiEventType(event);
  if (type === "thought_delta" || type === "reasoning_delta" || type === "thinking_delta")
    return trimText(event.delta) ?? trimText(event.text);
  const nested = assistantMessageEvent(event);
  const nestedType = trimText(nested?.type);
  return nestedType === "thinking_delta" ||
    nestedType === "thought_delta" ||
    nestedType === "reasoning_delta"
    ? (trimText(nested?.delta) ?? trimText(nested?.text))
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
      return record?.type === "text" ? (trimText(record.text) ?? "") : "";
    })
    .join("");
  return text || undefined;
}
