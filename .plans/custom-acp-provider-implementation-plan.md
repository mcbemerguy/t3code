# Plan: Custom ACP Provider

## Source of Truth

- Previous implementation brief: `.local/t3code/.plans/custom-acp-implementation-brief.md`.
- Every phase worker must read that brief before editing and fit low-level implementation choices to its instructions. This plan is the execution structure; the brief owns the detailed constraints and defaults.

## Goal

Add a fork-owned generic ACP-backed provider under driver kind `customAcp` / label `Custom ACP`, independent from upstream-looking `acpRegistry` and independent from Cursor-specific runtime defaults, while reusing the proven ACP session runtime and Cursor adapter lifecycle patterns.

## Global Constraints

- Keep `acpRegistry` untouched for future upstream/marketplace behavior; `customAcp` is the fork-owned explicit-provider path.
- Do not add a legacy `ServerSettings.providers.customAcp` mirror; support explicit `settings.providerInstances` entries only.
- Preserve Cursor behavior. Cursor may keep passing `cursor_login` and parameterized-model capabilities explicitly.
- Do not implement Pi ACP, fs/terminal ACP handlers, arbitrary extension mapping, or Cursor plan/todo extensions in this first implementation.
- Generic ACP must start with minimal client capabilities and only optional `_meta` negotiation from settings.
- Empty auth method means no ACP `authenticate` call; do not auto-pick an advertised auth method.
- Use the existing provider instance SPI, managed snapshot pattern, provider runtime event contracts, and text-generation abstraction.
- All phases must keep `bun fmt`, `bun lint`, and `bun typecheck` passing. Use `bun run test` for tests; never `bun test`.

## Phase 1: Generic ACP Foundation — done

Summary: Added `CustomAcpSettings`, generic ACP helper/parsing/model-discovery utilities, optional ACP auth, generic ask-question normalization, and focused tests. Commits reported: `50184c0c`, `cbc279f2`.

Purpose: make the ACP/runtime and settings surface capable of representing a generic process-launched ACP backend without creating the full provider instance yet.

Scope:

- Add the contract schema for `CustomAcpSettings` with annotated primitive fields compatible with the existing provider settings form.
- Add reusable server-side parsing/normalization helpers for launch args, env textarea, `_meta` JSON, manual fallback models, and ACP model config option discovery.
- Make `AcpSessionRuntime` auth optional while preserving Cursor’s explicit-auth path.
- Extract or add a generic ask-question extension module using the Cursor-compatible request/response shape described in the brief.
- Add focused tests around optional auth, config parsing, model discovery, and ask-question normalization.

Architecture notes:

- Keep behavior knobs in settings schema/defaults, not hidden extension-local fallback chains.
- Treat newline-separated args/env as the dependable UX; shell-like quoting can be supported only if tested.
- Generic model discovery should reuse ACP config semantics (`category: model`) and must not import Cursor capability derivation.

Acceptance:

- Contracts export `CustomAcpSettings` for web/server consumption.
- ACP runtime can initialize/create sessions without `authenticate` when auth is blank/omitted.
- Generic helper tests prove parsing and model discovery behavior without requiring a real provider driver.

## Phase 2: Custom ACP Server Provider — done

Summary: Added and registered Custom ACP server driver/provider, managed probe/snapshot/runtime factory, generic ACP adapter and text generation, plus server tests. Review fixes made fallback models avoid fake config writes and mapped invalid settings to typed errors. Commits reported: `16da8dd3`, `c280e386`.

Purpose: materialize `customAcp` as a server-side provider instance that can probe availability, expose models, start sessions, stream events, answer approvals/user-input requests, and support text generation.

Scope:

- Add a `CustomAcpDriver` and register it in the built-in driver list with only the infrastructure services it actually needs.
- Add a Custom ACP provider snapshot/probe layer using the managed provider pattern.
- Add a generic ACP runtime factory from `CustomAcpSettings` that launches the configured command/args/env, applies optional auth, minimal capabilities, and optional `_meta`.
- Add a generic ACP adapter implementing the full `ProviderAdapterShape` by reusing Cursor adapter lifecycle strategies while keeping provider identity, resume cursor, model selection, extension registration, and logging generic.
- Add generic ACP text generation based on the Cursor ACP text-generation pattern but with generic model switching and no Cursor option selections.
- Add server tests covering explicit `providerInstances.customAcp` hydration, optional auth, session start/send-turn against the ACP mock backend, user-input request/response, stale user-input cleanup, model switching, and model discovery fallback behavior.

Architecture notes:

- Prefer extracting reusable ACP lifecycle pieces only when the extraction is clear; a risk-reducing initial adapter may mirror Cursor structure, but Custom ACP-specific pieces must stay isolated so Cursor can converge later.
- Provider runtime events emitted by this adapter use `provider: customAcp`; instance stamping remains the responsibility of existing provider service plumbing.
- Resume cursor shape must be versioned and provider-specific, not shared with Cursor.
- Unknown/stale user-input responses must fail with the same cleanup-friendly wording pattern already used by Cursor.

Acceptance:

- A hand-authored explicit `providerInstances` entry with driver `customAcp` produces a live provider instance rather than an unavailable shadow.
- The provider can run against the existing ACP mock agent for start, prompt, event streaming, and ask-question interaction.
- Cursor tests still pass without changed runtime behavior.

## Phase 3: Web Settings Integration and End-to-End Polish — done

Summary: Added Custom ACP to active web provider metadata with neutral icon and existing primitive settings form support, kept ACP Registry coming-soon, prevented legacy provider mirror rows, and added UI-adjacent tests. Commit reported: `d1522e77`.

Purpose: expose Custom ACP in the settings UI and validate the complete user flow from adding a provider instance through using it in sessions/text generation.

Scope:

- Add `Custom ACP` to active provider client definitions with the new settings schema and a neutral icon; leave `ACP Registry` in coming-soon options.
- Ensure provider instance creation/editing handles the Custom ACP settings fields without bespoke UI beyond existing primitive controls.
- Verify any static provider option/picker lists that still gate provider selection include `customAcp` only where needed for explicit instances.
- Add or extend integration tests for the settings/UI-adjacent paths that can be tested without browser automation.
- Run the full repo validation commands and targeted ACP/provider tests.

Architecture notes:

- Do not duplicate display name inside driver config; use the provider instance envelope’s `displayName`.
- UI should present process launch settings plainly (`command`, args textarea, env textarea) and should not imply Cursor-only defaults.
- If a field is intentionally textarea-encoded rather than structured, server-side parsing and tests must be the source of truth.

Acceptance:

- Users can add/edit a `Custom ACP` provider instance from settings.
- The configured provider can be selected and used like other provider instances once the backend command is valid.
- `acpRegistry` remains unavailable/coming-soon and has no storage or runtime collision with `customAcp`.

## Cross-Phase Validation Targets

- `bun fmt`
- `bun lint`
- `bun typecheck`
- Targeted tests for ACP runtime/client/provider helpers and adapter behavior via `bun run test -- ...` as appropriate.
- Full `bun run test` if the implementation pass changes shared contracts/provider orchestration behavior substantially.
