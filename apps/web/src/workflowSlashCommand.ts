import type { ProviderWorkflowRunCursor } from "@t3tools/contracts";
import type { StandaloneComposerSlashCommand } from "./composer-logic";

export type WorkflowAbortSlashCommandResolution =
  | { status: "ready"; runId: string }
  | { status: "error"; title: string; description: string };

function isAbortableWorkflowRun(run: ProviderWorkflowRunCursor): boolean {
  return !run.terminal && run.actions.includes("abort");
}

function shortRunList(runs: ReadonlyArray<ProviderWorkflowRunCursor>): string {
  return runs
    .slice(0, 4)
    .map((run) => run.runId)
    .join(", ");
}

export function resolveWorkflowAbortSlashCommand(input: {
  command: Extract<StandaloneComposerSlashCommand, { kind: "workflow-abort" }>;
  workflowRuns: ReadonlyArray<ProviderWorkflowRunCursor>;
}): WorkflowAbortSlashCommandResolution {
  const abortableRuns = input.workflowRuns.filter(isAbortableWorkflowRun);
  const requestedRunId = input.command.runId?.trim();

  if (requestedRunId) {
    if (/\s/.test(requestedRunId)) {
      return {
        status: "error",
        title: "Invalid workflow abort command",
        description: "Use /workflow-abort <run-id> with one run id, or choose Abort from Tasks.",
      };
    }

    const run = input.workflowRuns.find((candidate) => candidate.runId === requestedRunId);
    if (!run) {
      return {
        status: "error",
        title: "Workflow run not found",
        description: `No workflow run matches ${requestedRunId}. Choose an active run from Tasks or use its full run id.`,
      };
    }
    if (!isAbortableWorkflowRun(run)) {
      return {
        status: "error",
        title: "Workflow run cannot be aborted",
        description: `Run ${requestedRunId} is ${run.terminal ? "terminal" : run.status} and does not expose Abort.`,
      };
    }
    return { status: "ready", runId: run.runId };
  }

  if (abortableRuns.length === 0) {
    return {
      status: "error",
      title: "No abortable workflow run",
      description: "There is no active or recoverable Pi workflow run with Abort available.",
    };
  }

  if (abortableRuns.length > 1) {
    return {
      status: "error",
      title: "Choose a workflow run to abort",
      description: `Multiple abortable Pi workflow runs exist. Use /workflow-abort <run-id> or choose Abort in Tasks. Runs: ${shortRunList(abortableRuns)}${abortableRuns.length > 4 ? ", …" : ""}`,
    };
  }

  const run = abortableRuns[0];
  if (!run) {
    return {
      status: "error",
      title: "No abortable workflow run",
      description: "There is no active or recoverable Pi workflow run with Abort available.",
    };
  }

  return { status: "ready", runId: run.runId };
}
