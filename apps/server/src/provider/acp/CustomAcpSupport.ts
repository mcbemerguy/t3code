import type {
  CustomAcpSettings,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const EMPTY_CUSTOM_ACP_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_CUSTOM_ACP_FALLBACK_MODEL = "default";

export interface CustomAcpSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCustomAcpSettingsError(cause: unknown): EffectAcpErrors.AcpTransportError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new EffectAcpErrors.AcpTransportError({
    detail: `Invalid Custom ACP settings: ${message}`,
    cause,
  });
}

function parseShellWords(line: string): ReadonlyArray<string> {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let hasToken = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    const next = line[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        current += char;
        hasToken = true;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\" && next === '"') {
        current += next;
        hasToken = true;
        index += 1;
      } else {
        current += char;
        hasToken = true;
      }
      continue;
    }

    if (char === "\\" && next !== undefined && (/\s/u.test(next) || next === "'" || next === '"')) {
      current += next;
      hasToken = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (quote) {
    throw new Error("Invalid Custom ACP arguments: unterminated quoted string");
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

export function parseCustomAcpArgs(input: string | null | undefined): ReadonlyArray<string> {
  if (!input) {
    return [];
  }
  const args: string[] = [];
  for (const line of input.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    args.push(...parseShellWords(trimmed));
  }
  return args;
}

export function parseCustomAcpEnv(input: string | null | undefined): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  if (!input) {
    return env;
  }

  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      throw new Error(`Invalid Custom ACP env line ${index + 1}: expected KEY=value`);
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!key || /\s|=/u.test(key)) {
      throw new Error(`Invalid Custom ACP env line ${index + 1}: invalid variable name`);
    }
    env[key] = line.slice(equalsIndex + 1).trim();
  }

  return env;
}

export function parseCustomAcpManualModels(
  input: string | ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const rawEntries = Array.isArray(input) ? input : String(input ?? "").split(/[\n,]/u);
  const seen = new Set<string>();
  const models: string[] = [];

  for (const entry of rawEntries) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    models.push(normalized);
  }

  return models;
}

export function parseCustomAcpClientCapabilitiesMetaJson(
  input: string | null | undefined,
): Record<string, unknown> | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new Error("Invalid Custom ACP client capabilities _meta JSON", { cause });
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid Custom ACP client capabilities _meta JSON: expected an object");
  }
  return parsed;
}

export function normalizeCustomAcpAuthMethodId(
  authMethodId: string | null | undefined,
): string | undefined {
  const normalized = authMethodId?.trim();
  return normalized ? normalized : undefined;
}

export function buildCustomAcpSpawnInput(
  settings: CustomAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const env = { ...environment, ...parseCustomAcpEnv(settings.env) };
  return {
    command: settings.command.trim(),
    args: parseCustomAcpArgs(settings.args),
    cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export interface CustomAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: CustomAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeCustomAcpRuntime = (
  input: CustomAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { childProcessSpawner, settings, environment, ...runtimeInput } = input;
    const parsedSettings = yield* Effect.try({
      try: () => ({
        authMethodId: normalizeCustomAcpAuthMethodId(settings.authMethodId),
        spawn: buildCustomAcpSpawnInput(settings, input.cwd, environment),
        clientCapabilities: buildCustomAcpClientCapabilities(settings),
      }),
      catch: toCustomAcpSettingsError,
    });
    const runtimeOptions = {
      ...runtimeInput,
      spawn: parsedSettings.spawn,
      clientCapabilities: parsedSettings.clientCapabilities,
    } satisfies Omit<AcpSessionRuntimeOptions, "authMethodId">;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer(
        parsedSettings.authMethodId
          ? { ...runtimeOptions, authMethodId: parsedSettings.authMethodId }
          : runtimeOptions,
      ).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export function buildCustomAcpClientCapabilities(
  settings: Pick<CustomAcpSettings, "clientCapabilitiesMetaJson">,
): EffectAcpSchema.InitializeRequest["clientCapabilities"] {
  const meta = parseCustomAcpClientCapabilitiesMetaJson(settings.clientCapabilitiesMetaJson);
  return meta ? { _meta: meta } : {};
}

export function flattenCustomAcpSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | null | undefined,
): ReadonlyArray<CustomAcpSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) => {
    const options = "value" in entry ? [entry] : entry.options;
    return options.flatMap((option) => {
      const value = option.value.trim();
      if (!value) {
        return [];
      }
      const name = option.name.trim() || value;
      const description = option.description?.trim() || undefined;
      return [
        {
          value,
          name,
          ...(description ? { description } : {}),
        } satisfies CustomAcpSelectOption,
      ];
    });
  });
}

export function findCustomAcpModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.category === "model");
}

export function findCustomAcpThoughtLevelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find(
    (option) => option.category === "thought_level" && option.type === "select",
  );
}

export function buildCustomAcpModelCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
) {
  const thoughtLevelOption = findCustomAcpThoughtLevelConfigOption(configOptions);
  const choices = flattenCustomAcpSessionConfigSelectOptions(thoughtLevelOption);
  if (!thoughtLevelOption || choices.length === 0) {
    return EMPTY_CUSTOM_ACP_MODEL_CAPABILITIES;
  }

  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: thoughtLevelOption.name?.trim() || "Reasoning",
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.name,
          isDefault: choice.value === thoughtLevelOption.currentValue,
        })),
      }),
    ],
  });
}

export function resolveCustomAcpReasoningConfigUpdate(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): { readonly configId: string; readonly value: string } | undefined {
  const selectionValue = input.selections?.find((selection) => selection.id === "reasoning")?.value;
  const requestedValue = typeof selectionValue === "string" ? selectionValue.trim() : undefined;
  if (!requestedValue) {
    return undefined;
  }

  const thoughtLevelOption = findCustomAcpThoughtLevelConfigOption(input.configOptions);
  const choices = flattenCustomAcpSessionConfigSelectOptions(thoughtLevelOption);
  if (!thoughtLevelOption || !choices.some((choice) => choice.value === requestedValue)) {
    return undefined;
  }

  return { configId: thoughtLevelOption.id, value: requestedValue };
}

export function discoverCustomAcpModelConfigId(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const id = findCustomAcpModelConfigOption(configOptions)?.id.trim();
  return id || undefined;
}

export function buildCustomAcpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findCustomAcpModelConfigOption(configOptions);
  const modelChoices = flattenCustomAcpSessionConfigSelectOptions(modelOption);
  const capabilities = buildCustomAcpModelCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const choice of modelChoices) {
    if (seen.has(choice.value)) {
      continue;
    }
    seen.add(choice.value);
    models.push({
      slug: choice.value,
      name: choice.name,
      isCustom: false,
      capabilities,
    });
  }

  return models;
}

export function buildCustomAcpProviderModels(input: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly manualModels?: string | ReadonlyArray<string> | null | undefined;
  readonly fallbackModel?: string | null | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  const capabilities = buildCustomAcpModelCapabilitiesFromConfigOptions(input.configOptions);

  for (const model of buildCustomAcpDiscoveredModelsFromConfigOptions(input.configOptions)) {
    seen.add(model.slug);
    models.push(model);
  }

  for (const slug of parseCustomAcpManualModels(input.manualModels)) {
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities,
    });
  }

  if (models.length === 0) {
    const fallback = input.fallbackModel?.trim() || DEFAULT_CUSTOM_ACP_FALLBACK_MODEL;
    models.push({
      slug: fallback,
      name: fallback,
      isCustom: true,
      capabilities,
    });
  }

  return models;
}
