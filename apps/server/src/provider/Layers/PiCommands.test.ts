import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { normalizePiCommands } from "./PiCommands.ts";

describe("Pi command normalization", () => {
  it("uses Pi skill command names as stable skill identities", () => {
    const result = normalizePiCommands({
      commands: [
        {
          name: "skill:browser-tools",
          description: "Interactive browser automation",
          source: "skill",
          sourceInfo: {
            path: "/mock/pi/skills/browser-tools/SKILL.md",
            source: "local",
            scope: "user",
            baseDir: "/mock/pi/skills/browser-tools",
          },
        },
        {
          name: "skill:repo-map",
          description: "Repository map",
          source: "skill",
          sourceInfo: {
            path: "/mock/packages/pi-extra/skills/repo-map/SKILL.md",
            source: "@mock/pi-extra",
            scope: "project",
            baseDir: "/mock/packages/pi-extra/skills/repo-map",
          },
        },
      ],
    });

    assert.deepEqual(result.skills, [
      {
        name: "browser-tools",
        description: "Interactive browser automation",
        path: "/mock/pi/skills/browser-tools/SKILL.md",
        scope: "user",
        enabled: true,
        displayName: "browser-tools",
        shortDescription: "Interactive browser automation",
      },
      {
        name: "repo-map",
        description: "Repository map",
        path: "/mock/packages/pi-extra/skills/repo-map/SKILL.md",
        scope: "project",
        enabled: true,
        displayName: "repo-map",
        shortDescription: "Repository map",
      },
    ]);
  });

  it("preserves extension and prompt command names as slash commands", () => {
    const result = normalizePiCommands({
      commands: [
        {
          name: "workflow:list",
          description: "List workflow runs",
          source: "extension",
          sourceInfo: { path: "/mock/pi/extensions/workflows/index.ts", source: "local" },
        },
        {
          name: "commit-message",
          description: "Draft a commit message",
          source: "prompt",
          sourceInfo: { path: "/workspace/.pi/prompts/commit-message.md", source: "local" },
        },
      ],
    });

    assert.deepEqual(result.slashCommands, [
      { name: "workflow:list", description: "List workflow runs" },
      { name: "commit-message", description: "Draft a commit message" },
    ]);
  });
});
