import type {
  ClientOrchestrationCommand,
  DispatchResult,
  EnvironmentApi,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

const visibleThreadDeleteErrors = new WeakSet<object>();

type ThreadDeleteToastManager = Pick<typeof toastManager, "add">;

type ThreadDeleteLogger = Pick<Console, "error" | "info" | "warn">;

export type ThreadDeleteActionDependencies = {
  api: EnvironmentApi | undefined;
  target: ScopedThreadRef;
  commandId: ClientOrchestrationCommand["commandId"];
  toast?: ThreadDeleteToastManager;
  logger?: ThreadDeleteLogger;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function markThreadDeleteErrorVisible(error: unknown): unknown {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    visibleThreadDeleteErrors.add(error);
  }
  return error;
}

export function isThreadDeleteErrorVisible(error: unknown): boolean {
  return Boolean(
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    visibleThreadDeleteErrors.has(error),
  );
}

export function showMissingThreadDeleteEnvironmentApi(input: {
  environmentId: EnvironmentId;
  threadId: ScopedThreadRef["threadId"];
  toast?: ThreadDeleteToastManager;
  logger?: ThreadDeleteLogger;
}): Error {
  const toast = input.toast ?? toastManager;
  const logger = input.logger ?? console;
  const error = new Error(`Environment API not found for environment ${input.environmentId}`);
  logger.error("Cannot delete thread because the environment API is unavailable", {
    environmentId: input.environmentId,
    threadId: input.threadId,
  });
  toast.add(
    stackedThreadToast({
      type: "error",
      title: "Cannot delete thread",
      description:
        "The environment connection is unavailable. Reconnect the environment and try again.",
    }),
  );
  markThreadDeleteErrorVisible(error);
  return error;
}

export function showThreadDeleteDispatchFailure(input: {
  target: ScopedThreadRef;
  error: unknown;
  toast?: ThreadDeleteToastManager;
  logger?: ThreadDeleteLogger;
}): void {
  const toast = input.toast ?? toastManager;
  const logger = input.logger ?? console;
  logger.error("Failed to dispatch thread delete", {
    environmentId: input.target.environmentId,
    threadId: input.target.threadId,
    error: input.error,
  });
  toast.add(
    stackedThreadToast({
      type: "error",
      title: "Failed to delete thread",
      description: errorMessage(
        input.error,
        "The delete request failed before reaching the server.",
      ),
    }),
  );
  markThreadDeleteErrorVisible(input.error);
}

export function showBackingSessionDeletionWarnings(input: {
  warnings: DispatchResult["warnings"];
  toast?: ThreadDeleteToastManager;
}): void {
  const toast = input.toast ?? toastManager;
  for (const warning of input.warnings ?? []) {
    if (warning.code !== "provider_backing_session_delete_failed") continue;
    toast.add(
      stackedThreadToast({
        type: "warning",
        title: "Thread deleted, but backing session cleanup failed",
        description: warning.detail ?? warning.message,
      }),
    );
  }
}

export async function dispatchThreadDeleteFirst(
  deps: ThreadDeleteActionDependencies,
): Promise<DispatchResult> {
  if (!deps.api) {
    throw showMissingThreadDeleteEnvironmentApi({
      environmentId: deps.target.environmentId,
      threadId: deps.target.threadId,
      ...(deps.toast !== undefined ? { toast: deps.toast } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });
  }

  const logger = deps.logger ?? console;

  try {
    logger.info("Dispatching thread delete", {
      environmentId: deps.target.environmentId,
      threadId: deps.target.threadId,
      commandId: deps.commandId,
    });
    const result = await deps.api.orchestration.dispatchCommand({
      type: "thread.delete",
      commandId: deps.commandId,
      threadId: deps.target.threadId,
    });
    showBackingSessionDeletionWarnings({
      warnings: result.warnings,
      ...(deps.toast !== undefined ? { toast: deps.toast } : {}),
    });
    return result;
  } catch (error) {
    showThreadDeleteDispatchFailure({
      target: deps.target,
      error,
      ...(deps.toast !== undefined ? { toast: deps.toast } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });
    throw error;
  }
}

export function closeTerminalAfterThreadDelete(input: {
  api: EnvironmentApi;
  target: ScopedThreadRef;
  logger?: ThreadDeleteLogger;
}): void {
  const logger = input.logger ?? console;
  void input.api.terminal
    .close({ threadId: input.target.threadId, deleteHistory: true })
    .catch((error: unknown) => {
      logger.warn("Terminal cleanup after thread deletion failed", {
        environmentId: input.target.environmentId,
        threadId: input.target.threadId,
        error,
      });
    });
}

export function showThreadDeleteUnexpectedError(input: {
  error: unknown;
  title?: string;
  toast?: ThreadDeleteToastManager;
  logger?: ThreadDeleteLogger;
}): void {
  const logger = input.logger ?? console;
  logger.error(input.title ?? "Thread delete action failed", { error: input.error });
  if (isThreadDeleteErrorVisible(input.error)) return;
  const toast = input.toast ?? toastManager;
  toast.add(
    stackedThreadToast({
      type: "error",
      title: input.title ?? "Failed to delete thread",
      description: errorMessage(input.error, "An unexpected error occurred."),
    }),
  );
  markThreadDeleteErrorVisible(input.error);
}
