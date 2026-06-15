import { ThreadId, TurnId } from "@t3tools/contracts";

import { readStringField } from "./PiToolPresentation.ts";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizePiReadThread(threadId: ThreadId, data: unknown) {
  const root = readRecord(data);
  const messages = Array.isArray(data) ? data : Array.isArray(root?.messages) ? root.messages : [];
  return {
    threadId,
    turns: messages.map((message, index) => ({
      id: TurnId.make(
        readStringField(message, "turnId") ??
          readStringField(message, "id") ??
          `pi-message-${index + 1}`,
      ),
      items: [message],
    })),
  };
}
