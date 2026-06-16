export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null | undefined>>;

export const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export interface PiThinkingModelMetadata {
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: PiThinkingLevelMap;
}

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && PI_THINKING_LEVELS.includes(value as PiThinkingLevel);
}

export function getSupportedPiThinkingLevels(
  model: PiThinkingModelMetadata,
): ReadonlyArray<PiThinkingLevel> {
  if (model.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap;
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}
