import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  getAvailableCustomAcpProviders,
  resolveCustomAcpImportModelSelection,
  resolveCustomAcpProviderForImport,
} from "./customAcpSessionImport";

function provider(input: {
  readonly id: string;
  readonly driver?: string;
  readonly enabled?: boolean;
  readonly availability?: "available" | "unavailable";
  readonly model?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make(input.driver ?? "customAcp"),
    displayName: input.id,
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-05-23T00:00:00.000Z",
    availability: input.availability ?? "available",
    models: [
      {
        slug: input.model ?? "model-a",
        name: input.model ?? "model-a",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

describe("Custom ACP import provider selection", () => {
  it("filters to enabled and available Custom ACP providers", () => {
    const providers = [
      provider({ id: "custom-disabled", enabled: false }),
      provider({ id: "custom-unavailable", availability: "unavailable" }),
      provider({ id: "codex", driver: "codex" }),
      provider({ id: "custom-ready" }),
    ];

    expect(getAvailableCustomAcpProviders(providers).map((entry) => entry.instanceId)).toEqual([
      "custom-ready",
    ]);
  });

  it("uses the preferred current/thread provider when it is available", () => {
    const preferred = ProviderInstanceId.make("custom-two");
    const result = resolveCustomAcpProviderForImport({
      providers: [provider({ id: "custom-one" }), provider({ id: preferred })],
      preferredProviderInstanceId: preferred,
    });

    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.provider.instanceId).toBe(preferred);
    }
  });

  it("auto-selects one candidate and requests a picker for multiple candidates", () => {
    expect(
      resolveCustomAcpProviderForImport({ providers: [provider({ id: "custom-one" })] }).kind,
    ).toBe("selected");

    const multiple = resolveCustomAcpProviderForImport({
      providers: [provider({ id: "custom-one" }), provider({ id: "custom-two" })],
    });

    expect(multiple.kind).toBe("picker");
  });
});

describe("Custom ACP import model selection", () => {
  it("builds an instance-scoped model selection for the import call", () => {
    const providerInstanceId = ProviderInstanceId.make("custom-one");
    const selection = resolveCustomAcpImportModelSelection({
      providerInstanceId,
      providers: [provider({ id: providerInstanceId, model: "acp-model" })],
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: {
          instanceId: providerInstanceId,
          model: "acp-model",
          options: [{ id: "reasoning", value: "high" }],
        },
      },
    });

    expect(selection).toEqual({
      instanceId: providerInstanceId,
      model: "acp-model",
      options: [{ id: "reasoning", value: "high" }],
    });
  });
});
