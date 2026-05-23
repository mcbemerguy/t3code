import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveAppModelSelectionForInstance } from "../modelSelection";

const CUSTOM_ACP_DRIVER = ProviderDriverKind.make("customAcp");

export type CustomAcpProviderResolution =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly provider: ProviderInstanceEntry }
  | { readonly kind: "picker"; readonly providers: ReadonlyArray<ProviderInstanceEntry> };

export function getAvailableCustomAcpProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)).filter(
    (entry) => entry.driverKind === CUSTOM_ACP_DRIVER && entry.enabled && entry.isAvailable,
  );
}

export function resolveCustomAcpProviderForImport(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly preferredProviderInstanceId?: ProviderInstanceId | null | undefined;
}): CustomAcpProviderResolution {
  const candidates = getAvailableCustomAcpProviders(input.providers);
  if (candidates.length === 0) {
    return { kind: "none" };
  }

  const preferred = input.preferredProviderInstanceId
    ? candidates.find((entry) => entry.instanceId === input.preferredProviderInstanceId)
    : undefined;
  if (preferred) {
    return { kind: "selected", provider: preferred };
  }

  if (candidates.length === 1) {
    return { kind: "selected", provider: candidates[0]! };
  }

  return { kind: "picker", providers: candidates };
}

export function resolveCustomAcpImportModelSelection(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection {
  const selected = input.settings.textGenerationModelSelection;
  const model =
    resolveAppModelSelectionForInstance(
      input.providerInstanceId,
      input.settings,
      input.providers,
      selected?.instanceId === input.providerInstanceId ? selected.model : null,
    ) ??
    DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[CUSTOM_ACP_DRIVER] ??
    "";

  return createModelSelection(
    input.providerInstanceId,
    model,
    selected?.instanceId === input.providerInstanceId ? selected.options : [],
  );
}

export function formatCustomAcpImportError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason;
    }
  }
  return "Unable to import ACP session.";
}
