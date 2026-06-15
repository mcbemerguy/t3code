import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  status?: ServerProvider["status"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("returns a ready native Pi instance", () => {
    const pi = ProviderInstanceId.make("pi_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: pi, status: "ready" }),
    ];

    expect(resolveSelectableProviderInstance(providers, pi)).toBe(pi);
  });

  it("falls back when the requested instance is not ready", () => {
    const limited = ProviderInstanceId.make("pi");
    const fallback = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: limited,
        status: "warning",
      }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, limited)).toBe(fallback);
  });

  it("does not return disabled, unavailable, warning, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const warning = ProviderInstanceId.make("pi");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: warning,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, warning)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});
