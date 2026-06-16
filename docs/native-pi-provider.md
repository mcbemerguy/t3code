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

Reasoning-capable Pi models expose T3's generic Reasoning selector and apply choices through Pi RPC `set_thinking_level`. T3 preserves Pi model metadata, filters unsupported levels using Pi's thinking-level rules, validates selected values before model mutation, and applies reasoning after concrete `set_model` calls so Pi clamps against the final active model. The `default` model still accepts a reasoning choice; T3 only skips `set_model` for `default`, not option application.

OpenAI Fast remains intentionally deferred for native Pi. T3 does not expose a writable Pi `fastMode` descriptor and ignores incoming Pi `fastMode` selections instead of sending `/fast` prompts. The exact reason is that T3's generic `fastMode` descriptor is writable in composer traits, while Pi currently exposes Fast only through Pi-owned extension commands/provider-request rewriting and no clean Pi RPC/core control path. Future Fast work should add a real Pi RPC/core session control first, then wire the generic descriptor to that protocol.

## Manual validation checklist

1. Start T3 with a native Pi provider instance (`driver: "pi"`, `binaryPath: "pi"`) and open a new thread.
2. Select a reasoning-capable Pi model discovered from `get_available_models`; confirm the composer traits show a Reasoning selector with only supported Pi levels.
3. Select a non-default reasoning level, send a turn, and verify Pi RPC state/events show the selected level, for example `thinking_level_changed` or `get_state.thinkingLevel` matching the choice.
4. Select the `default` Pi model with a reasoning level and send a turn; confirm no `set_model` is required but Pi still receives `set_thinking_level`.
5. Select a non-reasoning Pi model; confirm no Reasoning selector is shown.
6. Confirm OpenAI Codex Pi models do not show a writable Fast/Normal traits control. Fast must stay controlled by Pi until Pi exposes a non-prompt RPC/core API.

## Focused automated coverage

- `PiModels.test.ts` covers reasoning descriptor construction, non-reasoning omission, `thinkingLevelMap` filtering, explicit `xhigh` support, provider/model slug parsing, and Fast descriptor non-exposure.
- `PiSessionRuntime.test.ts` covers emission of the `set_thinking_level` RPC command.
- `PiAdapter.test.ts` covers ordering (`set_model` before `set_thinking_level`), `default` model reasoning application, invalid reasoning rejection before model mutation, and Fast selection ignoring without `/fast` prompt hacks.

## Known limitations and follow-ups

- Native Pi text-generation helpers for Git commit messages, PR text, branch names, and thread titles are not implemented yet. Those calls fail with a structured `TextGenerationError`.
- Native Pi rollback is unsupported because Pi RPC does not expose a safe thread rollback API.
- If the Pi subprocess exits while idle, T3 reports the failure on the next provider operation. Exits during startup or an in-flight RPC request include bounded process diagnostics and stderr/prelude tails.
