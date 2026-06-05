import { describe, expect, it, vi } from "vitest";
import type {
  ClientOrchestrationCommand,
  EnvironmentApi,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  closeTerminalAfterThreadDelete,
  dispatchThreadDeleteFirst,
  showSelectedThreadDeleteFailures,
} from "./threadDeleteAction.logic";

function commandId(): ClientOrchestrationCommand["commandId"] {
  return "command-test" as ClientOrchestrationCommand["commandId"];
}

function threadRef(): ScopedThreadRef {
  return {
    environmentId: "env-test" as ScopedThreadRef["environmentId"],
    threadId: "thread-test" as ScopedThreadRef["threadId"],
  };
}

function createToastRecorder() {
  return {
    add: vi.fn(),
  };
}

function createLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createApi(input: {
  dispatchCommand?: EnvironmentApi["orchestration"]["dispatchCommand"];
  close?: EnvironmentApi["terminal"]["close"];
}): EnvironmentApi {
  return {
    orchestration: {
      dispatchCommand:
        input.dispatchCommand ?? vi.fn().mockResolvedValue({ sequence: 1, warnings: undefined }),
    },
    terminal: {
      close: input.close ?? vi.fn().mockResolvedValue(undefined),
    },
  } as EnvironmentApi;
}

describe("thread delete action logic", () => {
  it("shows a toast and diagnostic log when the environment API is missing", async () => {
    const toast = createToastRecorder();
    const logger = createLogger();
    const target = threadRef();

    await expect(
      dispatchThreadDeleteFirst({
        api: undefined,
        target,
        commandId: commandId(),
        toast,
        logger,
      }),
    ).rejects.toThrow("Environment API not found");

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Cannot delete thread",
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Cannot delete thread because the environment API is unavailable",
      expect.objectContaining({ environmentId: target.environmentId, threadId: target.threadId }),
    );
  });

  it("logs the delete command id and does not let terminal close failure or timeout prevent thread.delete dispatch", async () => {
    const target = threadRef();
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 7, warnings: undefined });
    const close = vi.fn().mockReturnValue(new Promise(() => undefined));
    const api = createApi({ dispatchCommand, close });
    const logger = createLogger();

    await dispatchThreadDeleteFirst({ api, target, commandId: commandId(), logger });
    closeTerminalAfterThreadDelete({ api, target, logger });

    expect(logger.info).toHaveBeenCalledWith(
      "Dispatching thread delete",
      expect.objectContaining({
        environmentId: target.environmentId,
        threadId: target.threadId,
        commandId: "command-test",
      }),
    );
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.delete",
      commandId: "command-test",
      threadId: target.threadId,
    });
    expect(close).toHaveBeenCalledWith({ threadId: target.threadId, deleteHistory: true });
  });

  it("shows a visible error when thread.delete dispatch fails", async () => {
    const toast = createToastRecorder();
    const logger = createLogger();
    const target = threadRef();
    const error = new Error("dispatch unavailable");
    const api = createApi({ dispatchCommand: vi.fn().mockRejectedValue(error) });

    await expect(
      dispatchThreadDeleteFirst({ api, target, commandId: commandId(), toast, logger }),
    ).rejects.toBe(error);

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to delete thread",
        description: "dispatch unavailable",
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to dispatch thread delete",
      expect.objectContaining({
        environmentId: target.environmentId,
        threadId: target.threadId,
        error,
      }),
    );
  });

  it("shows provider cleanup warnings after a successful thread delete", async () => {
    const toast = createToastRecorder();
    const target = threadRef();
    const api = createApi({
      dispatchCommand: vi.fn().mockResolvedValue({
        sequence: 9,
        warnings: [
          {
            code: "provider_backing_session_delete_failed",
            message: "Provider cleanup failed",
            detail: "Pi session file could not be removed",
          },
        ],
      }),
    });

    await dispatchThreadDeleteFirst({ api, target, commandId: commandId(), toast });

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Thread deleted, but backing session cleanup failed",
        description: "Pi session file could not be removed",
      }),
    );
  });

  it("returns tombstone success when backing session cleanup diagnostics are warning-only", async () => {
    const toast = createToastRecorder();
    const target = threadRef();
    const warnings = [
      {
        code: "provider_backing_session_delete_failed",
        message: "Thread deleted, but the provider backing session may still exist.",
        detail:
          "Missing Pi backing session for workflow-emails-monitor; workflow run is already aborted.",
      },
    ];
    const api = createApi({
      dispatchCommand: vi.fn().mockResolvedValue({ sequence: 17, warnings }),
    });

    await expect(
      dispatchThreadDeleteFirst({ api, target, commandId: commandId(), toast }),
    ).resolves.toEqual({ sequence: 17, warnings });
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Thread deleted, but backing session cleanup failed",
        description:
          "Missing Pi backing session for workflow-emails-monitor; workflow run is already aborted.",
      }),
    );
  });

  it("shows an aggregate selected-thread failure toast even when the first error already had a toast", async () => {
    const toast = createToastRecorder();
    const logger = createLogger();
    const target = threadRef();
    const error = new Error("dispatch unavailable");
    const api = createApi({ dispatchCommand: vi.fn().mockRejectedValue(error) });

    await expect(
      dispatchThreadDeleteFirst({ api, target, commandId: commandId(), toast, logger }),
    ).rejects.toBe(error);

    showSelectedThreadDeleteFailures({
      failureCount: 2,
      firstError: error,
      toast,
      logger,
    });

    expect(toast.add).toHaveBeenCalledTimes(2);
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to delete 2 selected threads",
        description: "dispatch unavailable",
      }),
    );
  });
});
