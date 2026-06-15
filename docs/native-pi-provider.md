# Native Pi provider implementation notes

## Phase 1 baseline

Branch: `feature/native-pi-provider`, created from `upstream/main`.

Reference commits used for porting context:

- T3Code upstream baseline: `upstream/main` at `0e4a43519fe4fa85ce60aa8d6d53c067e56d2fca`
- T3Code fork reference: `custom-acp` at `41bd4548cb3de01dfb0f4f15b4313a703b70e861`
- Pi ACP adapter reference: `.local/pi-acp` at `fd7850e8f7c685f99c4582bb837e5cad0a733395`

Phase 1 registers a first-party `pi` driver without importing Custom ACP or `.local/pi-acp` runtime modules. The T3 settings surface is intentionally minimal: `enabled` and `binaryPath` only, with `binaryPath` defaulting to `pi`. Pi's own settings remain authoritative for model/provider behavior.

The Phase 1 provider snapshot used `pi --version` as the health probe and exposed a single fallback model, `default`, so the provider could render in settings/status surfaces before the Pi RPC runtime landed. Phase 6 now marks installed Pi providers ready, fills the model picker through `get_available_models`, and keeps `default` only as the explicit fallback when model discovery is unavailable.

Text generation for Git commit messages, PR text, branch names, and thread titles is deliberately unsupported for Pi in Phase 1. Calls fail with a structured `TextGenerationError` until a Pi-native text-generation strategy is implemented.

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

Native Pi discovers models with Pi RPC `get_available_models` and selects them with `set_model`. If model discovery is unavailable, T3 shows the explicit `default` fallback model and lets Pi keep its current/default model. Resume cursors include the Pi provider instance id so multiple Pi instances do not accidentally restore each other's sessions.
