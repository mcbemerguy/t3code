import { EnvironmentId, type ProviderWorkflowRunCursor } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import PlanSidebar from "./PlanSidebar";
import { WorkflowRunControls, stopActionForRun } from "./WorkflowRunControls";

const noop = async () => {};
const runningWorkflowRun: ProviderWorkflowRunCursor = {
  runId: "code-review-fix-20260605144500-b4spny",
  workflowId: "code-review-fix",
  status: "running" as const,
  terminal: false,
  lastSequence: 7,
  runDir: "C:/Users/marcos/.pi/agent/workflow-runs/code-review-fix-20260605144500-b4spny",
  auditPath:
    "C:/Users/marcos/.pi/agent/workflow-runs/code-review-fix-20260605144500-b4spny/audit.md",
  actions: ["interrupt", "abort"],
  updatedAt: "2026-06-05T14:45:00.000Z",
};

describe("WorkflowRunControls", () => {
  it("renders active Pi workflow identities and explicit controls", () => {
    const markup = renderToStaticMarkup(
      <WorkflowRunControls
        onControlWorkflowRun={noop}
        workflowRuns={[
          runningWorkflowRun,
          {
            runId: "recoverable-run-2",
            workflowId: "planner",
            status: "interrupted",
            terminal: false,
            lastSequence: 12,
            actions: ["continue", "abort"],
            updatedAt: "2026-06-05T14:46:00.000Z",
          },
          {
            runId: "terminal-run",
            status: "aborted",
            terminal: true,
            lastSequence: 13,
            actions: [],
            updatedAt: "2026-06-05T14:47:00.000Z",
          },
        ]}
      />,
    );

    expect(markup).toContain("Pi workflows");
    expect(markup).toContain("Choose a run");
    expect(markup).toContain("code-review-fix");
    expect(markup).toContain("code-revie");
    expect(markup).toContain("audit.md");
    expect(markup).toContain("Continue");
    expect(markup).toContain("Stop");
    expect(markup).toContain("Workflow actions for code-review-fix-20260605144500-b4spny");
    expect(markup).toContain("Abort is terminal");
    expect(markup).not.toContain("&gt;Interrupt&lt;");
    expect(markup).not.toContain("terminal-run");
  });

  it("derives Stop from workflow actions instead of generic turn interruption", () => {
    expect(stopActionForRun({ ...runningWorkflowRun, actions: ["interrupt", "pause"] })).toBe(
      "interrupt",
    );
    expect(stopActionForRun({ ...runningWorkflowRun, actions: ["pause"] })).toBe("pause");
    expect(stopActionForRun({ ...runningWorkflowRun, actions: ["abort"] })).toBeNull();

    const markup = renderToStaticMarkup(
      <WorkflowRunControls
        onControlWorkflowRun={noop}
        workflowRuns={[{ ...runningWorkflowRun, actions: ["abort"] }]}
      />,
    );

    expect(markup).not.toContain("Stop");
    expect(markup).toContain("Workflow actions for code-review-fix-20260605144500-b4spny");
  });

  it("keeps the Tasks sidebar populated by workflow controls without an empty plan state", () => {
    const markup = renderToStaticMarkup(
      <PlanSidebar
        activePlan={null}
        activeProposedPlan={null}
        label="Tasks"
        environmentId={EnvironmentId.make("env-1")}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        timestampFormat="24-hour"
        workflowRuns={[runningWorkflowRun]}
        mode="sidebar"
        onControlWorkflowRun={noop}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Tasks");
    expect(markup).toContain("Pi workflows");
    expect(markup).not.toContain("No active plan yet.");
  });
});
