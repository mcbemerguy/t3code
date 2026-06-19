import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCustomAcpClientCapabilities,
  buildCustomAcpProviderModels,
  buildCustomAcpSpawnInput,
  discoverCustomAcpModelConfigId,
  parseCustomAcpArgs,
  parseCustomAcpClientCapabilitiesMetaJson,
  parseCustomAcpEnv,
  parseCustomAcpManualModels,
} from "./CustomAcpSupport.ts";

const groupedModelConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [{ value: "ask", name: "Ask" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "composer-2",
    options: [
      {
        group: "cursor",
        name: "Cursor",
        options: [
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
        ],
      },
      {
        group: "anthropic",
        name: "Anthropic",
        options: [{ value: "claude-opus-4-6", name: "Opus 4.6" }],
      },
    ],
  },
];

describe("CustomAcpSupport", () => {
  it("parses newline args and shell-style quoting", () => {
    expect(
      parseCustomAcpArgs(`
        acp
        --profile "work profile"
        # comment
        --path 'C:\\Users\\Name With Spaces\\agent'
      `),
    ).toEqual(["acp", "--profile", "work profile", "--path", "C:\\Users\\Name With Spaces\\agent"]);
  });

  it("preserves literal backslashes in unquoted and double-quoted args", () => {
    expect(
      parseCustomAcpArgs(String.raw`
        --path C:\Users\Name\agent
        --quoted "C:\Users\Name With Spaces\agent"
        --regex ^\w+\s+$
      `),
    ).toEqual([
      "--path",
      String.raw`C:\Users\Name\agent`,
      "--quoted",
      String.raw`C:\Users\Name With Spaces\agent`,
      "--regex",
      String.raw`^\w+\s+$`,
    ]);
  });

  it("parses env KEY=value lines", () => {
    expect(
      parseCustomAcpEnv(`
        FOO=bar
        EMPTY=
        SPACED = value with spaces
        # ignored
      `),
    ).toEqual({ FOO: "bar", EMPTY: "", SPACED: "value with spaces" });
  });

  it("rejects malformed env lines", () => {
    expect(() => parseCustomAcpEnv("NOT_AN_ASSIGNMENT")).toThrow(/expected KEY=value/u);
  });

  it("parses _meta JSON objects only", () => {
    expect(
      parseCustomAcpClientCapabilitiesMetaJson('{ "parameterizedModelPicker": true }'),
    ).toEqual({
      parameterizedModelPicker: true,
    });
    expect(parseCustomAcpClientCapabilitiesMetaJson("   ")).toBeUndefined();
    expect(() => parseCustomAcpClientCapabilitiesMetaJson("[]")).toThrow(/expected an object/u);
  });

  it("deduplicates manual fallback models from newline and comma text", () => {
    expect(parseCustomAcpManualModels("default, gpt-5.4\n gpt-5.4\nclaude-opus")).toEqual([
      "default",
      "gpt-5.4",
      "claude-opus",
    ]);
  });

  it("discovers grouped ACP model config options and appends manual models", () => {
    expect(discoverCustomAcpModelConfigId(groupedModelConfigOptions)).toBe("model");
    expect(
      buildCustomAcpProviderModels({
        configOptions: groupedModelConfigOptions,
        manualModels: "gpt-5.4\nlocal-model",
      }).map((model) => ({ slug: model.slug, name: model.name, isCustom: model.isCustom })),
    ).toEqual([
      { slug: "composer-2", name: "Composer 2", isCustom: false },
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false },
      { slug: "claude-opus-4-6", name: "Opus 4.6", isCustom: false },
      { slug: "local-model", name: "local-model", isCustom: true },
    ]);
  });

  it("falls back to a default model when discovery and manual models are empty", () => {
    expect(
      buildCustomAcpProviderModels({ configOptions: [] }).map((model) => ({
        slug: model.slug,
        isCustom: model.isCustom,
      })),
    ).toEqual([{ slug: "default", isCustom: true }]);
  });

  it("builds launch and minimal capability inputs from settings", () => {
    const settings = {
      enabled: true,
      command: "agent",
      args: "acp\n--flag",
      env: "FOO=bar",
      authMethodId: "",
      askQuestionEnabled: true,
      askQuestionMethod: "cursor/ask_question",
      manualModels: "",
      clientCapabilitiesMetaJson: '{ "custom": true }',
    };

    expect(buildCustomAcpSpawnInput(settings, "/repo")).toEqual({
      command: "agent",
      args: ["acp", "--flag"],
      cwd: "/repo",
      env: { FOO: "bar" },
    });
    expect(buildCustomAcpClientCapabilities(settings)).toEqual({ _meta: { custom: true } });
  });
});
