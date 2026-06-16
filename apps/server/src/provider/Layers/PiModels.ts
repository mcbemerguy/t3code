import { type ModelCapabilities, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  getSupportedPiThinkingLevels,
  PI_THINKING_LEVEL_LABELS,
  type PiThinkingLevelMap,
} from "./PiThinking.ts";

const EMPTY_PI_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const FALLBACK_MODEL_SLUG = "default";

export const FALLBACK_PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: FALLBACK_MODEL_SLUG,
    name: "Pi default",
    isCustom: false,
    capabilities: EMPTY_PI_MODEL_CAPABILITIES,
  },
];

interface PiModelCandidate {
  readonly id: string;
  readonly name?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: PiThinkingLevelMap;
}

export interface PiModelSelectionTarget {
  readonly provider: string;
  readonly modelId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = readTrimmedString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readThinkingLevelMap(value: unknown): PiThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;
  const map: PiThinkingLevelMap = {};
  for (const level of Object.keys(PI_THINKING_LEVEL_LABELS) as Array<
    keyof typeof PI_THINKING_LEVEL_LABELS
  >) {
    const mapped = value[level];
    if (mapped === null || typeof mapped === "string") map[level] = mapped;
  }
  return map;
}

function candidateFromModel(
  raw: unknown,
  inheritedProvider?: string,
): PiModelCandidate | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return undefined;
    const parsed = parsePiModelSelection(value);
    return parsed
      ? { id: parsed.modelId, provider: parsed.provider }
      : { id: value, ...(inheritedProvider ? { provider: inheritedProvider } : {}) };
  }

  if (!isRecord(raw)) return undefined;
  const id = stringField(raw, ["id", "modelId", "slug", "name"]);
  if (!id) return undefined;
  const name = stringField(raw, ["name", "displayName", "label"]);
  const provider = stringField(raw, ["provider", "providerId"]) ?? inheritedProvider;
  const api = stringField(raw, ["api"]);
  const reasoning = booleanField(raw, "reasoning");
  const thinkingLevelMap = readThinkingLevelMap(raw.thinkingLevelMap);
  return {
    id,
    ...(name ? { name } : {}),
    ...(provider ? { provider } : {}),
    ...(api ? { api } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

function candidatesFromProviderRecord(
  raw: Record<string, unknown>,
): ReadonlyArray<PiModelCandidate> {
  const provider = stringField(raw, ["id", "provider", "providerId", "name"]);
  const models = Array.isArray(raw.models)
    ? raw.models
    : Array.isArray(raw.availableModels)
      ? raw.availableModels
      : [];
  return models.flatMap((model) => {
    const candidate = candidateFromModel(model, provider);
    return candidate ? [candidate] : [];
  });
}

function readCandidates(payload: unknown): ReadonlyArray<PiModelCandidate> {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      const candidate = candidateFromModel(entry);
      return candidate ? [candidate] : [];
    });
  }

  if (!isRecord(payload)) return [];

  const directModels = Array.isArray(payload.models) ? payload.models : undefined;
  if (directModels) {
    return directModels.flatMap((entry) => {
      const candidate = candidateFromModel(entry);
      return candidate ? [candidate] : [];
    });
  }

  const availableModels = Array.isArray(payload.availableModels)
    ? payload.availableModels
    : undefined;
  if (availableModels) {
    return availableModels.flatMap((entry) => {
      const candidate = candidateFromModel(entry);
      return candidate ? [candidate] : [];
    });
  }

  if (Array.isArray(payload.providers)) {
    return payload.providers.flatMap((provider) =>
      isRecord(provider) ? candidatesFromProviderRecord(provider) : [],
    );
  }

  if (isRecord(payload.models)) {
    return Object.entries(payload.models).flatMap(([provider, models]) =>
      Array.isArray(models)
        ? models.flatMap((model) => {
            const candidate = candidateFromModel(model, provider);
            return candidate ? [candidate] : [];
          })
        : [],
    );
  }

  return [];
}

function makePiModelCapabilities(candidate: PiModelCandidate): ModelCapabilities {
  if (candidate.reasoning !== true) return EMPTY_PI_MODEL_CAPABILITIES;

  const thinkingLevels = getSupportedPiThinkingLevels(candidate);
  const firstLevel = thinkingLevels[0];
  if (!firstLevel) return EMPTY_PI_MODEL_CAPABILITIES;

  const defaultLevel = thinkingLevels.includes("medium") ? "medium" : firstLevel;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select" as const,
        options: thinkingLevels.map((level) => ({
          id: level,
          label: PI_THINKING_LEVEL_LABELS[level],
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        currentValue: defaultLevel,
      },
    ],
  });
}

export function normalizePiAvailableModels(payload: unknown): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const candidate of readCandidates(payload)) {
    const parsedId = candidate.provider ? undefined : parsePiModelSelection(candidate.id);
    const provider = candidate.provider ?? parsedId?.provider;
    const modelId = candidate.provider ? candidate.id : parsedId?.modelId;
    if (!provider || !modelId) continue;

    const slug = `${provider}/${modelId}`;
    if (!slug.trim() || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: candidate.name ?? modelId,
      shortName: candidate.name ?? modelId,
      subProvider: provider,
      isCustom: false,
      capabilities: makePiModelCapabilities(candidate),
    });
  }

  return models.length > 0 ? models : FALLBACK_PI_MODELS;
}

export function parsePiModelSelection(model: string): PiModelSelectionTarget | undefined {
  const trimmed = model.trim();
  if (!trimmed || trimmed === FALLBACK_MODEL_SLUG) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slashIndex),
    modelId: trimmed.slice(slashIndex + 1),
  };
}
