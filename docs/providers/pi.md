# Pi

Use the native Pi provider when you want T3 Code to launch `pi --mode rpc` directly.

## Setup

In Settings, add or edit a provider instance:

```text
Driver: Pi
Binary path: pi
```

Pi's own settings continue to control models, API providers, credentials, and behavior. T3 Code only needs the Pi binary path.

## Migrating from Custom ACP Pi

Replace the old Custom ACP entry with a native provider instance:

```json
{
  "driver": "pi",
  "config": {
    "binaryPath": "pi"
  }
}
```

Do not point T3 Code at `pi-acp` for native Pi. The native provider talks to Pi RPC directly.

## Models

T3 Code asks Pi for models with `get_available_models` and applies picker changes with `set_model`. If Pi cannot report models, T3 Code shows one explicit fallback model, `default`, which leaves model choice to Pi.

Reasoning-capable Pi models show the generic Reasoning selector. T3 applies that value through Pi RPC `set_thinking_level`, including when the selected model is `default`.

OpenAI Fast is not exposed as a native Pi Fast Mode option yet. Pi currently controls Fast through its own extension commands and provider-request rewriting, not through a clean RPC/core session API. T3 therefore avoids showing a writable Fast control that would appear to work but could only be implemented with a `/fast` prompt hack.
