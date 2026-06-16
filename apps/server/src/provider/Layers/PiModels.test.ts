import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  FALLBACK_PI_MODELS,
  normalizePiAvailableModels,
  parsePiModelSelection,
} from "./PiModels.ts";

describe("Pi model normalization", () => {
  it("normalizes Pi RPC model lists into provider/model slugs", () => {
    const models = normalizePiAvailableModels({
      models: [
        { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
        { id: "gpt-5.2", name: "GPT 5.2", provider: "openai" },
      ],
    });

    assert.deepEqual(
      models.map((model) => ({
        slug: model.slug,
        name: model.name,
        subProvider: model.subProvider,
      })),
      [
        { slug: "anthropic/claude-opus-4-5", name: "Claude Opus 4.5", subProvider: "anthropic" },
        { slug: "openai/gpt-5.2", name: "GPT 5.2", subProvider: "openai" },
      ],
    );
  });

  it("builds Pi reasoning capabilities from model metadata", () => {
    const models = normalizePiAvailableModels({
      models: [
        {
          id: "gpt-5.4",
          name: "GPT 5.4",
          provider: "openai-codex",
          api: "openai-codex-responses",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            high: "high",
            xhigh: "xhigh",
          },
        },
      ],
    });

    assert.deepEqual(models[0]?.capabilities?.optionDescriptors, [
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
        ],
        currentValue: "medium",
      },
    ]);
  });

  it("does not expose reasoning capabilities for non-reasoning Pi models", () => {
    const models = normalizePiAvailableModels({
      models: [{ id: "plain-model", provider: "mock", reasoning: false }],
    });

    assert.deepEqual(models[0]?.capabilities?.optionDescriptors, []);
  });

  it("only exposes xhigh when Pi metadata explicitly supports it", () => {
    const models = normalizePiAvailableModels({
      models: [{ id: "reasoning-model", provider: "mock", reasoning: true }],
    });

    const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    assert.equal(descriptor?.type, "select");
    assert.deepEqual(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
      ["off", "minimal", "low", "medium", "high"],
    );
  });

  it("normalizes provider-grouped model lists", () => {
    const models = normalizePiAvailableModels({
      providers: [{ id: "mock", models: [{ id: "model-a" }, "model-b"] }],
    });

    assert.deepEqual(
      models.map((model) => model.slug),
      ["mock/model-a", "mock/model-b"],
    );
  });

  it("falls back to Pi default when RPC returns no usable models", () => {
    assert.equal(normalizePiAvailableModels({ models: [] }), FALLBACK_PI_MODELS);
    assert.deepEqual(
      normalizePiAvailableModels({ models: [] }).map((model) => model.slug),
      ["default"],
    );
  });

  it("does not expose providerless model ids that set_model cannot apply", () => {
    assert.deepEqual(
      normalizePiAvailableModels({ models: [{ id: "model-a" }, "model-b"] }).map(
        (model) => model.slug,
      ),
      ["default"],
    );
    assert.deepEqual(
      normalizePiAvailableModels(["mock/model-c", { id: "mock/model-d", name: "Model D" }]).map(
        (model) => ({ slug: model.slug, name: model.name, subProvider: model.subProvider }),
      ),
      [
        { slug: "mock/model-c", name: "model-c", subProvider: "mock" },
        { slug: "mock/model-d", name: "Model D", subProvider: "mock" },
      ],
    );
  });

  it("parses selectable Pi model slugs for set_model", () => {
    assert.deepEqual(parsePiModelSelection("anthropic/claude-opus-4-5"), {
      provider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    assert.equal(parsePiModelSelection("default"), undefined);
    assert.equal(parsePiModelSelection("claude-opus-4-5"), undefined);
  });
});
