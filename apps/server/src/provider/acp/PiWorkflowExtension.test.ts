import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  makeCustomAcpResumeCursor,
  parseCustomAcpResume,
  parsePiWorkflowEventNotification,
  parsePiWorkflowRuns,
  workflowMetaFromRawPayload,
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
      activeWorkflowRuns: [{ runId: "run-1", lastSequence: 5, runDir: "/tmp/run-1" }],
    });

    expect(parseCustomAcpResume(provider, cursor)).toEqual({
      sessionId: "pi-session",
      requireResumeSession: true,
      activeWorkflowRuns: [{ runId: "run-1", lastSequence: 5, runDir: "/tmp/run-1" }],
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
