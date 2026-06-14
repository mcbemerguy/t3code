import type { ProviderWorkflowRunCursor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveWorkflowAbortSlashCommand } from "./workflowSlashCommand";

function workflowRun(overrides: Partial<ProviderWorkflowRunCursor>): ProviderWorkflowRunCursor {
  return {
    runId: "run-1",
    status: "running",
    terminal: false,
    lastSequence: 1,
    actions: ["abort"],
    updatedAt: "2026-06-05T14:45:00.000Z",
    ...overrides,
  };
}

describe("resolveWorkflowAbortSlashCommand", () => {
  it("resolves the only abortable workflow run when no run id is provided", () => {
    expect(
      resolveWorkflowAbortSlashCommand({
        command: { kind: "workflow-abort" },
        workflowRuns: [workflowRun({ runId: "run-1" })],
      }),
    ).toEqual({ status: "ready", runId: "run-1" });
  });

  it("requires a run id when multiple abortable workflow runs exist", () => {
    const result = resolveWorkflowAbortSlashCommand({
      command: { kind: "workflow-abort" },
      workflowRuns: [workflowRun({ runId: "run-1" }), workflowRun({ runId: "run-2" })],
    });

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ title: "Choose a workflow run to abort" });
  });

  it("rejects terminal or non-abortable workflow runs", () => {
    const result = resolveWorkflowAbortSlashCommand({
      command: { kind: "workflow-abort", runId: "done-run" },
      workflowRuns: [
        workflowRun({ runId: "done-run", status: "completed", terminal: true, actions: [] }),
      ],
    });

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ title: "Workflow run cannot be aborted" });
  });
});
