import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  extractPiWorkflowCapabilities,
  makeCustomAcpResumeCursor,
  parseCustomAcpResume,
  parsePiWorkflowEventNotification,
  parsePiWorkflowRuns,
  workflowCursorFromResumeRun,
  workflowMetaFromRawPayload,
  workflowRunFromRecord,
} from "./PiWorkflowExtension.ts";

const provider = ProviderDriverKind.make("customAcp");

describe("Pi workflow ACP extension helpers", () => {
  it("migrates version 1 resume cursors without workflow metadata", () => {
    expect(
      parseCustomAcpResume(provider, {
        schemaVersion: 1,
        provider,
        sessionId: "pi-session",
        requireSessionLoad: true,
      }),
    ).toEqual({
      sessionId: "pi-session",
      requireResumeSession: true,
      activeWorkflowRuns: [],
    });
  });

  it("round-trips active workflow run sequence metadata in version 2 cursors", () => {
    const cursor = makeCustomAcpResumeCursor({
      provider,
      sessionId: "pi-session",
      requireSessionLoad: true,
      activeWorkflowRuns: [
        { runId: "run-1", workflowId: "code-review", lastSequence: 5, runDir: "/tmp/run-1" },
      ],
    });

    expect(parseCustomAcpResume(provider, cursor)).toEqual({
      sessionId: "pi-session",
      requireResumeSession: true,
      activeWorkflowRuns: [
        { runId: "run-1", workflowId: "code-review", lastSequence: 5, runDir: "/tmp/run-1" },
      ],
    });
  });

  it("extracts the Pi workflow interrupt capability", () => {
    expect(
      extractPiWorkflowCapabilities({
        agentCapabilities: {
          _meta: {
            piAcp: {
              workflows: true,
              workflowMethods: [
                "_pi/workflows/list",
                "_pi/workflows/resume",
                "_pi/workflows/interrupt",
                "_pi/workflows/abort",
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      resumeMethod: "_pi/workflows/resume",
      interruptMethod: "_pi/workflows/interrupt",
      abortMethod: "_pi/workflows/abort",
    });
  });

  it("parses workflow list responses for stop fallback discovery", () => {
    expect(
      parsePiWorkflowRuns({
        runs: [
          { id: "run-1", lastSequence: 3, runDir: "/tmp/run-1", status: "running" },
          { runId: "run-2", auditPath: "/tmp/run-2/audit.md", status: "paused" },
          { id: "" },
        ],
      }),
    ).toEqual([
      { runId: "run-1", lastSequence: 3, runDir: "/tmp/run-1", status: "running" },
      { runId: "run-2", lastSequence: 0, auditPath: "/tmp/run-2/audit.md", status: "paused" },
    ]);
  });

  it("parses workflow event notifications used for replay cursor dedupe", () => {
    expect(
      parsePiWorkflowEventNotification("_pi/workflows/events", {
        sessionId: "pi-session",
        runId: "run-1",
        sequence: 9,
        event: { type: "step_start", runId: "run-1", sequence: 9 },
      }),
    ).toEqual({
      runId: "run-1",
      sequence: 9,
      record: { type: "step_start", runId: "run-1", sequence: 9 },
    });
  });

  it("preserves run cursor state across step events with step-local statuses", () => {
    const previous = {
      runId: "run-1",
      lastSequence: 3,
      workflowId: "code-review",
      runDir: "/tmp/run-1",
      auditPath: "/tmp/run-1/audit.md",
      status: "running",
    };

    const run = workflowRunFromRecord(
      "run-1",
      4,
      { type: "step_end", stepId: "code", status: "completed" },
      previous,
    );
    const cursor = workflowCursorFromResumeRun({
      run,
      capabilities: {
        interruptMethod: "_pi/workflows/interrupt",
        abortMethod: "_pi/workflows/abort",
      },
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(cursor).toMatchObject({
      runId: "run-1",
      status: "running",
      terminal: false,
      lastSequence: 4,
      workflowId: "code-review",
      runDir: "/tmp/run-1",
      auditPath: "/tmp/run-1/audit.md",
      actions: ["interrupt", "abort"],
    });
  });

  it("promotes recovering runs back to running on resumed step activity", () => {
    const run = workflowRunFromRecord(
      "run-1",
      5,
      { type: "step_start", stepId: "code", status: "running" },
      {
        runId: "run-1",
        lastSequence: 4,
        status: "recovering",
      },
    );

    expect(run).toMatchObject({
      runId: "run-1",
      lastSequence: 5,
      status: "running",
    });
  });

  it("uses run-level terminal events to close workflow cursors", () => {
    const run = workflowRunFromRecord("run-1", 9, { type: "run_end", status: "completed" });
    const cursor = workflowCursorFromResumeRun({
      run,
      capabilities: { resumeMethod: "_pi/workflows/resume" },
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(cursor).toMatchObject({
      runId: "run-1",
      status: "completed",
      terminal: true,
      actions: [],
    });
  });

  it("extracts workflow metadata from replayed ACP session updates", () => {
    expect(
      workflowMetaFromRawPayload({
        sessionUpdate: "tool_call",
        _meta: { piWorkflow: { runId: "run-1" } },
      }),
    ).toEqual({ runId: "run-1" });

    expect(
      workflowMetaFromRawPayload({
        sessionId: "pi-session",
        update: {
          sessionUpdate: "tool_call",
          _meta: { piWorkflow: { runId: "run-2" } },
        },
      }),
    ).toEqual({ runId: "run-2" });
  });
});
