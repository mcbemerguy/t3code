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
