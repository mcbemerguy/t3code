# Native Pi provider implementation notes

## Phase 1 baseline

Branch: `feature/native-pi-provider`, created from `upstream/main`.

Reference commits used for porting context:

- T3Code upstream baseline: `upstream/main` at `0e4a43519fe4fa85ce60aa8d6d53c067e56d2fca`
- T3Code fork reference: `custom-acp` at `41bd4548cb3de01dfb0f4f15b4313a703b70e861`
- Pi ACP adapter reference: `.local/pi-acp` at `fd7850e8f7c685f99c4582bb837e5cad0a733395`

Phase 1 registers a first-party `pi` driver without importing Custom ACP or `.local/pi-acp` runtime modules. The T3 settings surface is intentionally minimal: `enabled` and `binaryPath` only, with `binaryPath` defaulting to `pi`. Pi's own settings remain authoritative for model/provider behavior.

The initial provider snapshot uses `pi --version` as the health probe and exposes a single fallback model, `default`, so the provider can render in settings/model surfaces before the Pi RPC runtime lands. Later phases should replace that fallback with direct Pi RPC `get_available_models` discovery and `set_model` handling at session/runtime level.

Text generation for Git commit messages, PR text, branch names, and thread titles is deliberately unsupported for Pi in Phase 1. Calls fail with a structured `TextGenerationError` until a Pi-native text-generation strategy is implemented.
