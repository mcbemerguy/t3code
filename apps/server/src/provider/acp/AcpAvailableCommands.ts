import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

export function normalizeAcpAvailableCommandsToSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const normalizedCommands: ServerProviderSlashCommand[] = [];

  for (const command of commands) {
    const name = command.name.trim().replace(/^\/+/, "").trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const description = command.description?.trim() || undefined;
    const hint = command.input?.hint?.trim() || undefined;
    normalizedCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }

  return normalizedCommands;
}
