import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowRunControls } from "./WorkflowRunControls";

const noop = async () => {};

describe("WorkflowRunControls", () => {
  it("renders Pi workflow identities and explicit controls without a competing interrupt action", () => {
    const markup = renderToStaticMarkup(
      <WorkflowRunControls
        isWorking
        onStopRunningWorkflow={noop}
        onControlWorkflowRun={noop}
        workflowRuns={[
          {
            runId: "code-review-fix-20260605144500-b4spny",
            workflowId: "code-review-fix",
            status: "running",
            terminal: false,
            lastSequence: 7,
            runDir: "C:/Users/marcos/.pi/agent/workflow-runs/code-review-fix-20260605144500-b4spny",
            auditPath:
              "C:/Users/marcos/.pi/agent/workflow-runs/code-review-fix-20260605144500-b4spny/audit.md",
            actions: ["interrupt", "abort"],
            updatedAt: "2026-06-05T14:45:00.000Z",
          },
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
    expect(markup).not.toContain(">Interrupt<");
    expect(markup).not.toContain("terminal-run");
  });
});
