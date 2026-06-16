# Native Pi provider implementation notes

The native `pi` driver launches `pi --mode rpc` directly and does not import Custom ACP or `pi-acp` runtime modules. The T3 settings surface stays intentionally minimal: `enabled` and `binaryPath`, with `binaryPath` defaulting to `pi`. Pi's own settings remain authoritative for model/provider behavior, credentials, and API routing.

Native Pi sessions support chat, assistant text/thought streaming, tool rendering, edit diffs, usage/context updates, active-turn steering, interruption/cancel, extension UI dialogs, Pi session restore, workflow replay/control, model discovery, and in-session model selection through Pi RPC.

## Migration from Custom ACP Pi

Use the native provider instance instead of a Custom ACP entry that launches Pi through `pi-acp`:

- set the provider instance `driver` to `"pi"`;
- set `config.binaryPath` to `"pi"` unless Pi is outside `PATH`;
- keep Pi model/provider/API behavior in Pi's own settings.

Example provider instance:

```json
{
  "driver": "pi",
  "displayName": "Pi",
  "config": {
    "binaryPath": "pi"
  }
}
```

Native Pi discovers models with Pi RPC `get_available_models` and selects them with `set_model`. Selectable model slugs use the `provider/modelId` shape returned by Pi. If model discovery is unavailable, T3 shows the explicit `default` fallback model and lets Pi keep its current/default model. Resume cursors include the Pi provider instance id so multiple Pi instances do not accidentally restore each other's sessions.

Reasoning-capable Pi models expose T3's generic Reasoning selector and apply choices through Pi RPC `set_thinking_level`. OpenAI Fast is intentionally not exposed as a Pi `fastMode` model option yet: T3 treats that descriptor as writable in composer traits, while Pi currently exposes Fast only through Pi-owned extension commands/provider-request rewriting and no clean Pi RPC/core control path.

## Known limitations and follow-ups

- Native Pi text-generation helpers for Git commit messages, PR text, branch names, and thread titles are not implemented yet. Those calls fail with a structured `TextGenerationError`.
- Native Pi rollback is unsupported because Pi RPC does not expose a safe thread rollback API.
- If the Pi subprocess exits while idle, T3 reports the failure on the next provider operation. Exits during startup or an in-flight RPC request include bounded process diagnostics and stderr/prelude tails.
