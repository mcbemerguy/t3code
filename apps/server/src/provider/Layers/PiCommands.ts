import { type ServerProviderSkill, type ServerProviderSlashCommand } from "@t3tools/contracts";

interface PiSourceInfoCandidate {
  readonly path?: string;
  readonly source?: string;
  readonly scope?: string;
  readonly baseDir?: string;
}

interface PiCommandCandidate {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo?: PiSourceInfoCandidate;
}

export interface PiCommandDiscoveryResult {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSource(value: unknown): PiCommandCandidate["source"] | undefined {
  return value === "extension" || value === "prompt" || value === "skill" ? value : undefined;
}

function readSourceInfo(value: unknown): PiSourceInfoCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const path = readTrimmedString(value.path);
  const source = readTrimmedString(value.source);
  const scope = readTrimmedString(value.scope);
  const baseDir = readTrimmedString(value.baseDir);
  if (!path && !source && !scope && !baseDir) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(source ? { source } : {}),
    ...(scope ? { scope } : {}),
    ...(baseDir ? { baseDir } : {}),
  };
}

function readCommand(value: unknown): PiCommandCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const name = readTrimmedString(value.name);
  const source = readSource(value.source);
  if (!name || !source) return undefined;
  const description = readTrimmedString(value.description);
  const sourceInfo = readSourceInfo(value.sourceInfo);
  return {
    name,
    source,
    ...(description ? { description } : {}),
    ...(sourceInfo ? { sourceInfo } : {}),
  };
}

function readCommands(payload: unknown): ReadonlyArray<PiCommandCandidate> {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      const command = readCommand(entry);
      return command ? [command] : [];
    });
  }

  if (!isRecord(payload) || !Array.isArray(payload.commands)) return [];
  return payload.commands.flatMap((entry) => {
    const command = readCommand(entry);
    return command ? [command] : [];
  });
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = readTrimmedString(command.name);
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, { ...command, name });
      continue;
    }
    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function normalizeSkillName(command: PiCommandCandidate): string | undefined {
  const fromSourceInfo = readTrimmedString(command.sourceInfo?.source);
  if (fromSourceInfo) return fromSourceInfo;

  const withoutPrefix = command.name.startsWith("skill:")
    ? command.name.slice("skill:".length)
    : command.name;
  return readTrimmedString(withoutPrefix);
}

function mapSkill(command: PiCommandCandidate): ServerProviderSkill | undefined {
  const name = normalizeSkillName(command);
  const path =
    readTrimmedString(command.sourceInfo?.path) ?? readTrimmedString(command.sourceInfo?.baseDir);
  if (!name || !path) return undefined;

  const description = readTrimmedString(command.description);
  const scope = readTrimmedString(command.sourceInfo?.scope);
  return {
    name,
    ...(description ? { description } : {}),
    path,
    ...(scope ? { scope } : {}),
    enabled: true,
    displayName: name,
    ...(description ? { shortDescription: description } : {}),
  };
}

function dedupeSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByKey = new Map<string, ServerProviderSkill>();

  for (const skill of skills) {
    const key = `${skill.scope ?? ""}:${skill.path}:${skill.name}`.toLowerCase();
    const existing = skillsByKey.get(key);
    if (!existing) {
      skillsByKey.set(key, skill);
      continue;
    }
    skillsByKey.set(key, {
      ...existing,
      ...(existing.description ? {} : skill.description ? { description: skill.description } : {}),
      ...(existing.shortDescription
        ? {}
        : skill.shortDescription
          ? { shortDescription: skill.shortDescription }
          : {}),
    });
  }

  return [...skillsByKey.values()];
}

export function normalizePiCommands(payload: unknown): PiCommandDiscoveryResult {
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];

  for (const command of readCommands(payload)) {
    if (command.source === "skill") {
      const skill = mapSkill(command);
      if (skill) skills.push(skill);
      continue;
    }

    slashCommands.push({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
    });
  }

  return {
    slashCommands: dedupeSlashCommands(slashCommands),
    skills: dedupeSkills(skills),
  };
}
