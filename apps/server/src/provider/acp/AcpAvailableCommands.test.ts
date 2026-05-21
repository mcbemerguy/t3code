import { describe, it, assert } from "@effect/vitest";

import { normalizeAcpAvailableCommandsToSlashCommands } from "./AcpAvailableCommands.ts";

describe("normalizeAcpAvailableCommandsToSlashCommands", () => {
  it("normalizes ACP commands for provider slash menus", () => {
    const commands = normalizeAcpAvailableCommandsToSlashCommands([
      {
        name: " /workflow:review-fix ",
        description: " Review and fix ",
        input: { hint: " scope " },
      },
      {
        name: "WORKFLOW:review-fix",
        description: "Duplicate",
      },
      {
        name: "///ask",
        description: "   ",
        input: { hint: "   " },
      },
      {
        name: " / ",
        description: "empty",
      },
    ]);

    assert.deepStrictEqual(commands, [
      {
        name: "workflow:review-fix",
        description: "Review and fix",
        input: { hint: "scope" },
      },
      {
        name: "ask",
      },
    ]);
  });
});
