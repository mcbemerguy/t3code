// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type RuntimePlanStepStatus,
} from "@t3tools/contracts";

import type { PiAdapterSessionContext } from "./PiAdapterTypes.ts";
import { inferPiUsageContextChange, piWorkflowUsageContextKey } from "./PiUsage.ts";
import type { PiWorkflowReplayRecord } from "./PiWorkflowArtifacts.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type StepPlan = { readonly step: string; readonly status: RuntimePlanStepStatus };

export class PiWorkflowEventMapper {
  private readonly seenFallback = new Set<string>();
  private readonly steps = new Map<string, StepPlan>();
  private readonly emittedChildTextMessages = new Set<string>();
  private readonly pendingNoIdMessageEndSuppressions = new Set<string>();
  private readonly noIdMessageSequences = new Map<string, number>();

  map(
    session: PiAdapterSessionContext,
    input: PiWorkflowReplayRecord | Record<string, unknown>,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const replay = isReplayRecord(input) ? input : undefined;
    const record = replay ? replay.record : input;
    if (!isRecord(record)) return [];
    const type = stringField(record.type);
    const runId = stringField(record.runId);
    if (!type || !runId) return [];
    if (!replay && !this.acceptFallback(record)) return [];
    const source = replay?.source;

    switch (type) {
      case "run_start":
        return this.mapRunStart(session, record, runId, source);
      case "run_end":
        return this.mapRunEnd(session, record, runId, source);
      case "run_paused":
      case "run_interrupted":
      case "run_resume_requested":
        return this.mapRunControl(session, record, runId, type, source);
      case "step_start":
      case "step_update":
      case "step_end":
      case "inline_subworkflow_start":
      case "inline_subworkflow_end":
      case "subworkflow_call_start":
      case "subworkflow_call_end":
        return this.mapStep(session, record, runId, type, source);
      case "child_pi_event":
        return this.mapChildEvent(session, record, runId, source);
      case "context_usage_update":
        return this.mapUsage(session, record, source);
      default:
        return [];
    }
  }

  private mapRunStart(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const workflowId =
      stringField(record.workflowId) ?? stringField(record.rootWorkflowId) ?? "workflow";
    return [
      {
        ...basePiWorkflowEvent(session, record, source, { itemId: workflowItemId(runId) }),
        type: "item.started",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: `Workflow: ${workflowId}`,
          data: workflowMeta(record),
        },
      },
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "task.started",
        payload: {
          taskId: workflowTaskId(runId),
          taskType: "pi.workflow",
          description: `Workflow ${workflowId} started`,
        },
      },
    ];
  }

  private mapRunEnd(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const workflowId =
      stringField(record.workflowId) ?? stringField(record.rootWorkflowId) ?? "workflow";
    const failed = isFailedStatus(record);
    const auditPath = stringField(record.auditPath);
    const auditText = auditPath ? ` Audit: ${pathToFileURL(auditPath).href}` : "";
    const summary = `Workflow ${workflowId} ${failed ? "failed" : "completed"}.${auditText}`;
    return [
      {
        ...basePiWorkflowEvent(session, record, source, { itemId: workflowItemId(runId) }),
        type: "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: failed ? "failed" : "completed",
          title: `Workflow: ${workflowId}`,
          data: workflowMeta(record),
        },
      },
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "task.completed",
        payload: {
          taskId: workflowTaskId(runId),
          status: failed ? "failed" : "completed",
          summary,
        },
      },
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: summary },
      },
    ];
  }

  private mapRunControl(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    type: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const workflowId =
      stringField(record.workflowId) ?? stringField(record.rootWorkflowId) ?? "workflow";
    const label =
      type === "run_resume_requested"
        ? "resume requested"
        : type === "run_paused"
          ? "paused"
          : "interrupted";
    return [
      {
        ...basePiWorkflowEvent(session, record, source, { itemId: workflowItemId(runId) }),
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: `Workflow: ${workflowId}`,
          detail: `Workflow ${label}`,
          data: workflowMeta(record),
        },
      },
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "task.progress",
        payload: { taskId: workflowTaskId(runId), description: `Workflow ${workflowId} ${label}` },
      },
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: `Workflow ${workflowId} ${label}.` },
      },
    ];
  }

  private mapStep(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    type: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const stepId = stringField(record.stepId);
    const startedAt = stringField(record.startedAt);
    const id = type.startsWith("subworkflow_call_")
      ? [runId, stepId, stringField(record.toolName), startedAt].filter(Boolean).join(":")
      : [runId, stepId].filter(Boolean).join(":");
    if (!id) return [];
    const step = { step: stepTitle(record, type), status: stepStatus(record, type) };
    const previous = this.steps.get(id);
    if (previous?.step === step.step && previous.status === step.status) return [];
    this.steps.set(id, step);
    return [
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "turn.plan.updated",
        payload: { plan: Array.from(this.steps.values()) },
      },
    ];
  }

  private mapChildEvent(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const childType = stringField(record.childEventType);
    const stepId = stringField(record.stepId) ?? "step";
    const event = isRecord(record.event) ? record.event : undefined;
    if (!childType || !event) return [];
    if (childType === "message_update") {
      const assistant = isRecord(event.assistantMessageEvent)
        ? event.assistantMessageEvent
        : undefined;
      if (!assistant) return [];
      if (assistant.type === "text_start") {
        this.advancePendingNoIdMessageEndSuppression(runId, stepId, record);
        return [];
      }
      if (assistant.type === "text_delta") return [];
      if (assistant.type === "text_end") {
        const text = stringField(assistant.content);
        return text
          ? this.mapChildFinalAssistantText(session, record, runId, stepId, event, text, source, {
              assistantMessageEvent: assistant,
              suppressFollowingNoIdMessageEnd: true,
            })
          : [];
      }
      if (assistant.type === "thinking_delta") {
        const delta = stringField(assistant.delta);
        return delta
          ? [
              {
                ...basePiWorkflowEvent(session, record, source),
                type: "content.delta",
                payload: { streamKind: "reasoning_text", delta },
              },
            ]
          : [];
      }
      return [];
    }
    if (childType === "message_end") {
      const text = assistantText(isRecord(event.message) ? event.message : undefined);
      return text
        ? this.mapChildFinalAssistantText(session, record, runId, stepId, event, text, source)
        : [];
    }
    if (!childType.startsWith("tool_execution_")) return [];
    const toolCallId = stringField(event.toolCallId) ?? `${stepId}-${childType}`;
    const itemId = runtimeItemId(`pi-workflow-${runId}-${stepId}-${toolCallId}`);
    const toolName = stringField(event.toolName) ?? "tool";
    if (childType === "tool_execution_start")
      return [
        {
          ...basePiWorkflowEvent(session, record, source, { itemId }),
          type: "item.started",
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: toolName,
            data: event.args,
          },
        },
      ];
    const output = stringifyToolOutput(
      childType === "tool_execution_update" ? event.partialResult : event.result,
    );
    const events: Array<ProviderRuntimeEvent> = [];
    if (output)
      events.push({
        ...basePiWorkflowEvent(session, record, source, { itemId }),
        type: "content.delta",
        payload: { streamKind: "command_output", delta: output },
      });
    if (childType === "tool_execution_end")
      events.push({
        ...basePiWorkflowEvent(session, record, source, { itemId }),
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: event.isError === true ? "failed" : "completed",
          title: toolName,
          data: event.result,
        },
      });
    return events;
  }

  private mapChildFinalAssistantText(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    runId: string,
    stepId: string,
    event: Record<string, unknown>,
    text: string,
    source: PiWorkflowReplayRecord["source"] | undefined,
    options: {
      readonly assistantMessageEvent?: Record<string, unknown>;
      readonly suppressFollowingNoIdMessageEnd?: boolean;
    } = {},
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const identity = this.childMessageIdentity(
      runId,
      stepId,
      stringField(record.childSessionId),
      event,
      options.assistantMessageEvent,
    );
    if (this.emittedChildTextMessages.has(identity.sourceKey)) {
      this.resolvePendingNoIdMessageEndSuppression(identity, runId, stepId, record);
      return [];
    }
    const pendingNoIdIdentity = this.currentNoIdChildMessageIdentity(
      runId,
      stepId,
      stringField(record.childSessionId),
    );
    if (this.pendingNoIdMessageEndSuppressions.has(pendingNoIdIdentity.sourceKey)) {
      this.pendingNoIdMessageEndSuppressions.delete(pendingNoIdIdentity.sourceKey);
      this.advanceNoIdChildMessageSequence(runId, stepId, stringField(record.childSessionId));
      return [];
    }
    this.emittedChildTextMessages.add(identity.sourceKey);
    if (!identity.hasExplicitId) {
      if (options.suppressFollowingNoIdMessageEnd)
        this.pendingNoIdMessageEndSuppressions.add(identity.sourceKey);
      else this.advanceNoIdChildMessageSequence(runId, stepId, stringField(record.childSessionId));
    }
    return [
      {
        ...basePiWorkflowEvent(session, record, source),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: text },
      },
    ];
  }

  private childMessageIdentity(
    runId: string,
    stepId: string,
    childSessionId: string | undefined,
    event: Record<string, unknown>,
    assistantMessageEvent?: Record<string, unknown>,
  ): { readonly sourceKey: string; readonly hasExplicitId: boolean } {
    const explicitId = childMessageExplicitId(event, assistantMessageEvent);
    if (explicitId)
      return {
        sourceKey: childMessageSourceKey(runId, stepId, childSessionId, explicitId),
        hasExplicitId: true,
      };
    return this.currentNoIdChildMessageIdentity(runId, stepId, childSessionId);
  }

  private currentNoIdChildMessageIdentity(
    runId: string,
    stepId: string,
    childSessionId: string | undefined,
  ): { readonly sourceKey: string; readonly hasExplicitId: false } {
    const baseKey = childMessageNoIdBaseKey(runId, stepId, childSessionId);
    const sequence = this.noIdMessageSequences.get(baseKey) ?? 0;
    return { sourceKey: `${baseKey}:seq:${sequence}`, hasExplicitId: false };
  }

  private advanceNoIdChildMessageSequence(
    runId: string,
    stepId: string,
    childSessionId: string | undefined,
  ): void {
    const baseKey = childMessageNoIdBaseKey(runId, stepId, childSessionId);
    this.noIdMessageSequences.set(baseKey, (this.noIdMessageSequences.get(baseKey) ?? 0) + 1);
  }

  private resolvePendingNoIdMessageEndSuppression(
    identity: { readonly sourceKey: string; readonly hasExplicitId: boolean },
    runId: string,
    stepId: string,
    record: Record<string, unknown>,
  ): void {
    if (
      identity.hasExplicitId ||
      !this.pendingNoIdMessageEndSuppressions.delete(identity.sourceKey)
    )
      return;
    this.advanceNoIdChildMessageSequence(runId, stepId, stringField(record.childSessionId));
  }

  private advancePendingNoIdMessageEndSuppression(
    runId: string,
    stepId: string,
    record: Record<string, unknown>,
  ): void {
    const identity = this.currentNoIdChildMessageIdentity(
      runId,
      stepId,
      stringField(record.childSessionId),
    );
    if (!this.pendingNoIdMessageEndSuppressions.delete(identity.sourceKey)) return;
    this.advanceNoIdChildMessageSequence(runId, stepId, stringField(record.childSessionId));
  }

  private mapUsage(
    session: PiAdapterSessionContext,
    record: Record<string, unknown>,
    source: PiWorkflowReplayRecord["source"] | undefined,
  ): ReadonlyArray<ProviderRuntimeEvent> {
    const stats = record.usage ?? record;
    const contextKey = piWorkflowUsageContextKey(record);
    const contextChange = inferPiUsageContextChange(record);
    const usage = session.usageState.update({
      source: "workflow",
      stats,
      ...(contextKey ? { contextKey } : {}),
      ...(contextChange ? { contextChange } : {}),
    });
    return usage
      ? [
          {
            ...basePiWorkflowEvent(session, record, source),
            type: "thread.token-usage.updated",
            payload: { usage },
          },
        ]
      : [];
  }

  private acceptFallback(record: Record<string, unknown>): boolean {
    const key = `${record.runId ?? ""}:${record.sequence ?? ""}:${record.type ?? ""}:${JSON.stringify(record)}`;
    if (this.seenFallback.has(key)) return false;
    this.seenFallback.add(key);
    return true;
  }
}

export function basePiWorkflowEvent(
  session: PiAdapterSessionContext,
  record: Record<string, unknown>,
  source?: PiWorkflowReplayRecord["source"],
  input?: { readonly itemId?: RuntimeItemId },
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: EventId.make(`pi-workflow-${randomUUID()}`),
    provider: PROVIDER,
    threadId: session.threadId,
    createdAt: new Date().toISOString(),
    ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
    ...(input?.itemId ? { itemId: input.itemId } : {}),
    raw: {
      source: "pi.workflow.artifact",
      method: stringField(record.type) ?? "workflow_event",
      payload: { ...record, ...(source ? { _source: source } : {}) },
    },
  };
}

function isReplayRecord(value: unknown): value is PiWorkflowReplayRecord {
  return isRecord(value) && isRecord(value.record) && isRecord(value.source);
}

function workflowItemId(runId: string): RuntimeItemId {
  return runtimeItemId(`pi-workflow-${runId}`);
}

function workflowTaskId(runId: string): RuntimeTaskId {
  return RuntimeTaskId.make(`pi-workflow-${runId}`.replace(/[^A-Za-z0-9_.:-]/g, "-"));
}

function runtimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value.replace(/[^A-Za-z0-9_.:-]/g, "-"));
}

function workflowMeta(record: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: stringField(record.runId),
    workflowId: stringField(record.workflowId) ?? stringField(record.rootWorkflowId),
    runDir: stringField(record.runDir),
    auditPath: stringField(record.auditPath),
    status: stringField(record.status),
  };
}

function stepStatus(record: Record<string, unknown>, type: string): RuntimePlanStepStatus {
  if (type === "step_end" || type === "inline_subworkflow_end" || type === "subworkflow_call_end")
    return "completed";
  const status = stringField(record.status)?.toLowerCase();
  return status === "completed" || status === "failed" || status === "error"
    ? "completed"
    : "inProgress";
}

function stepTitle(record: Record<string, unknown>, type: string): string {
  if (type.startsWith("subworkflow_call_")) {
    const child =
      stringField(record.childWorkflowId) ?? stringField(record.workflowId) ?? "workflow";
    const task = stringField(record.task);
    return task ? `Subworkflow: ${child} — ${task}` : `Subworkflow: ${child}`;
  }
  const stepId = stringField(record.stepId) ?? stringField(record.workflowId) ?? "workflow";
  const stepType =
    stringField(record.stepType) ??
    (type.startsWith("inline_subworkflow_") ? "workflow" : undefined);
  return stepType ? `Workflow step: ${stepId} (${stepType})` : `Workflow step: ${stepId}`;
}

function assistantText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return (
    message.content
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("") || undefined
  );
}

function childMessageExplicitId(
  event: Record<string, unknown>,
  assistantMessageEvent?: Record<string, unknown>,
): string | undefined {
  return (
    stringField(event.messageId) ??
    (isRecord(event.message) ? stringField(event.message.id) : undefined) ??
    (isRecord(assistantMessageEvent?.partial)
      ? stringField(assistantMessageEvent.partial.id)
      : undefined)
  );
}

function childMessageSourceKey(
  runId: string,
  stepId: string,
  childSessionId: string | undefined,
  messageId: string,
): string {
  return [
    "workflow",
    runId,
    "step",
    stepId,
    "child",
    childSessionId ?? "unknown",
    "message",
    messageId,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function childMessageNoIdBaseKey(
  runId: string,
  stepId: string,
  childSessionId: string | undefined,
): string {
  return childMessageSourceKey(runId, stepId, childSessionId, "current");
}

function stringifyToolOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return value === undefined ? undefined : JSON.stringify(value);
  const text = [value.stdout, value.stderr, value.output, value.text]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n");
  return text || JSON.stringify(value);
}

function isFailedStatus(record: Record<string, unknown>): boolean {
  const status = stringField(record.status)?.toLowerCase();
  return status === "failed" || status === "error" || status === "aborted" || Boolean(record.error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
