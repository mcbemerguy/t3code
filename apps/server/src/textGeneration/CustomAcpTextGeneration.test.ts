// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CustomAcpSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeCustomAcpTextGeneration } from "./CustomAcpTextGeneration.ts";

const decodeCustomAcpSettings = Schema.decodeSync(CustomAcpSettings);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../scripts/acp-mock-agent.ts");
const instanceId = ProviderInstanceId.make("customAcp");

const testLayer = NodeServices.layer;

function makeSettings(): CustomAcpSettings {
  return decodeCustomAcpSettings({
    command: "node",
    args: mockAgentPath,
  });
}

function makeEnvironment(promptResponseText: string): NodeJS.ProcessEnv {
  return { ...process.env, T3_ACP_PROMPT_RESPONSE_TEXT: promptResponseText };
}

describe("CustomAcpTextGeneration", () => {
  it.effect("extracts structured output and sanitizes generated branch names", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCustomAcpTextGeneration(
        makeSettings(),
        makeEnvironment(
          'Here is the JSON:\n{"branch":"Feature: Native Pi + Custom ACP!!!"}\nDone.',
        ),
      );

      const result = yield* textGeneration.generateBranchName({
        cwd: process.cwd(),
        message: "Add Custom ACP",
        modelSelection: createModelSelection(instanceId, "default"),
      });

      assert.deepStrictEqual(result, { branch: "feature-native-pi-custom-acp" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sanitizes commit subjects and optional branch names", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCustomAcpTextGeneration(
        makeSettings(),
        makeEnvironment(
          JSON.stringify({
            subject: "  Add Custom ACP.\nextra",
            body: "\nDetails\n",
            branch: "Custom ACP Integration",
          }),
        ),
      );

      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "summary",
        stagedPatch: "diff",
        includeBranch: true,
        modelSelection: createModelSelection(instanceId, "default"),
      });

      assert.deepStrictEqual(result, {
        subject: "Add Custom ACP",
        body: "Details",
        branch: "feature/custom-acp-integration",
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
