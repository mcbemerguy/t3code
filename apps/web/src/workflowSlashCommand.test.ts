import { describe, expect, it } from "vitest";
import type { ProviderWorkflowRunCursor } from "@t3tools/contracts";

import { resolveWorkflowAbortSlashCommand } from "./workflowSlashCommand";

function workflowRun(
  runId: string,
  overrides: Partial<ProviderWorkflowRunCursor> = {},
): ProviderWorkflowRunCursor {
  return {
    runId,
    status: "interrupted",
    terminal: false,
    lastSequence: 1,
    actions: ["continue", "abort"],
    updatedAt: "2026-06-05T15:30:00.000Z",
    ...overrides,
  };
}

describe("resolveWorkflowAbortSlashCommand", () => {
  it("routes a single abortable workflow run to provider workflow control", () => {
    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort" },
        workflowRuns: [workflowRun("run-1")],
      }),
    ).toEqual({ status: "ready", runId: "run-1" });
  });

  it("requires an explicit run id when multiple abortable runs exist", () => {
    const resolution = resolveWorkflowAbortSlashCommand({
      command: { kind: "workflow-abort" },
      workflowRuns: [workflowRun("run-1"), workflowRun("run-2")],
    });

    expect(resolution.status).toBe("error");
    if (resolution.status !== "error") throw new Error("expected error resolution");
    expect(resolution).toMatchObject({
      title: "Choose a workflow run to abort",
    });
    expect(resolution.description).toContain("/workflow-abort <run-id>");
    expect(resolution.description).toContain("run-1");
    expect(resolution.description).toContain("run-2");
  });

  it("resolves an explicit run id among multiple recoverable runs", () => {
    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort", runId: "run-2" },
        workflowRuns: [workflowRun("run-1"), workflowRun("run-2")],
      }),
    ).toEqual({ status: "ready", runId: "run-2" });
  });

  it("fails visibly for missing or non-abortable runs", () => {
    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort" },
        workflowRuns: [],
      }),
    ).toMatchObject({ status: "error", title: "No abortable workflow run" });

    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort", runId: "done-run" },
        workflowRuns: [
          workflowRun("done-run", { status: "completed", terminal: true, actions: [] }),
        ],
      }),
    ).toMatchObject({ status: "error", title: "Workflow run cannot be aborted" });
  });

  it("rejects malformed run selectors so /workflow-abort text is not sent", () => {
    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort", runId: "run-1 extra" },
        workflowRuns: [workflowRun("run-1")],
      }),
    ).toMatchObject({ status: "error", title: "Invalid workflow abort command" });
  });
});
