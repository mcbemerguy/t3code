# Implementation Discovery Brief: fork-owned Custom ACP provider

## Objective
Implement a full working generic ACP client/provider in the T3 Code fork, decoupled from upstream’s future `acpRegistry` and from Cursor-specific code, so it can later be wired to a Pi ACP adapter. The feature should let users add/configure an ACP-backed provider in the app, start sessions, send turns, receive streamed assistant/tool/plan events, handle blocking ask-question extension requests, and discover models from ACP session config when available.

## Current repo findings
- ACP client/protocol already exists in `packages/effect-acp/`:
  - `src/client.ts` exposes `AcpClient`, typed core request handlers, typed/fallback extension handlers, stdio child-process layer.
  - `src/_generated/schema.gen.ts` contains ACP schemas (`InitializeRequest`, `SessionConfigOption`, session setup/update, auth methods, etc.).
- Server ACP runtime already exists in `apps/server/src/provider/acp/AcpSessionRuntime.ts`:
  - Spawns an ACP child process over stdio.
  - Initializes, authenticates, creates/loads sessions, prompts, cancels, sets model/config options.
  - Parses ACP `session/update` into internal `AcpParsedSessionEvent` values.
  - Exposes extension request/notification handler registration.
  - Currently requires `authMethodId` and always calls `authenticate`; must become optional for generic ACP.
  - Currently hardcodes `mcpServers: []`; acceptable initially unless planner wants to expose later.
- Cursor is already ACP-backed:
  - `apps/server/src/provider/acp/CursorAcpSupport.ts` builds `agent acp` runtime and applies Cursor model config.
  - `apps/server/src/provider/Layers/CursorAdapter.ts` is the main adapter; it is the best implementation reference for session lifecycle, runtime events, approvals, pending user input, resume cursor, turn completion, stop/interrupt, and event streaming.
  - `apps/server/src/provider/acp/CursorAcpExtension.ts` already defines Cursor extension schemas and maps `cursor/ask_question` to T3 `UserInputQuestion`.
- Client-side blocking user-input UX already exists and is generic:
  - Contracts: `packages/contracts/src/providerRuntime.ts` has `user-input.requested` / `user-input.resolved` and `UserInputQuestion`.
  - Orchestration command: `thread.user-input.respond` in `packages/contracts/src/orchestration.ts`.
  - Server reactor routes responses via `ProviderService.respondToUserInput` in `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
  - UI derives pending user input in `apps/web/src/session-logic.ts` and renders in `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`.
- Provider instance architecture is ready:
  - Driver SPI: `apps/server/src/provider/ProviderDriver.ts`.
  - Registry/hydration: `ProviderInstanceRegistryLive.ts`, `ProviderInstanceRegistryHydration.ts`.
  - Explicit `settings.providerInstances` entries with open `ProviderDriverKind` are supported. Unknown drivers round-trip as unavailable shadows.
  - `ServerSettings.providers` is legacy-only; a new custom ACP driver does not need a legacy mirror if it is added only via `providerInstances`.
- Add Provider UI already has a disabled “ACP Registry” coming-soon option:
  - `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`.
  - Provider client definitions are in `apps/web/src/components/settings/providerDriverMeta.ts` and render schema-annotated settings via `ProviderSettingsForm.tsx`.
  - Settings form supports string/password/textarea/switch controls, not rich arrays; parse newline/comma text fields server-side or via schema transforms.

## Decisions made
1. **Provider identity**
   - Use fork-owned driver kind `customAcp` and UI label `Custom ACP`.
   - Do not consume upstream-looking `acpRegistry`. Leave it available for future upstream implementation so both can coexist.

2. **Extension scope for first implementation**
   - Implement only generic blocking ask-question support.
   - Use Cursor-compatible request/response shape by default, with configurable method name:
     - Request: `{ toolCallId?, title?, questions: [{ id, prompt, options, allowMultiple }] }`.
     - `options` should accept Cursor-style `{ id, label }[]`; map option labels to T3 answers.
     - Response: `{ answers }`, where answers are T3 `ProviderUserInputAnswers` (`Record<string, string | string[]>`).
   - Default method should be Cursor-compatible (`cursor/ask_question`) unless disabled/overridden by settings. Recommended fields: `askQuestionEnabled` boolean default true, `askQuestionMethod` string default `cursor/ask_question`.
   - Do not implement Cursor `create_plan` / `update_todos` in this first pass unless cheap after modularization.

3. **Auth policy**
   - `authMethodId` configurable.
   - If blank/omitted, `AcpSessionRuntime` should initialize and skip `authenticate`.
   - Do not auto-pick the first auth method; that can trigger unexpected auth behavior.
   - Do not use Cursor’s `cursor_login` by default.

4. **Model/config behavior**
   - Discover models from ACP session config options where `category === "model"`, especially select options.
   - Also allow manual fallback/custom models in settings for ACP backends that do not advertise models.
   - Generic model switching should call `runtime.setModel(model)` using ACP’s model config id discovered by `AcpSessionRuntime.extractModelConfigId`, without Cursor-specific parameterized model logic.
   - Generic provider should degrade gracefully to a fallback/default model if discovery yields none.

5. **Launch config**
   - UI/settings should expose separate `command`, `args`, and optional `env` fields.
   - Use a textarea for args and env.
   - Prefer parsing args into an argv array without going through a shell. Support shell-like quoting if feasible; at minimum document/test newline-separated args. Avoid single shell command string as the storage model.
   - Env textarea can use `KEY=value` lines merged over process env.

6. **Client capabilities**
   - Minimal by default: `fs.readTextFile = false`, `fs.writeTextFile = false`, `terminal = false`.
   - Allow optional raw JSON `_meta` client capabilities setting for custom/Pi extension negotiation.
   - Do not advertise Cursor’s parameterized model picker by default.
   - Do not enable fs/terminal handlers in first pass.

## Recommended architecture

### Contracts/settings
- Add `CustomAcpSettings` to `packages/contracts/src/settings.ts`, exported via existing barrel.
- Keep it out of `ServerSettings.providers` unless a default legacy `customAcp` instance is desired. Current decision favors explicit provider instances only.
- Suggested fields (names can be refined):
  - `enabled` boolean hidden/default true.
  - `command` string (binary/path), required effectively; empty should make provider unavailable with clear message.
  - `args` textarea string; parse to argv.
  - `env` textarea string, `KEY=value` lines.
  - `authMethodId` string; blank means skip authenticate.
  - `askQuestionEnabled` boolean default true.
  - `askQuestionMethod` string default `cursor/ask_question`.
  - `manualModels` textarea string; newline/comma separated fallback model ids.
  - `clientCapabilitiesMetaJson` textarea string; optional JSON object merged into `clientCapabilities._meta`.
  - Optional `displayName` is already envelope-level `ProviderInstanceConfig.displayName`; avoid duplicating unless needed.
- Add a `CustomAcpSettingsPatch` only if this setting is included in legacy `ServerSettings.providers`; otherwise not needed.

### Web UI
- Add provider client definition in `apps/web/src/components/settings/providerDriverMeta.ts`:
  - `value: ProviderDriverKind.make("customAcp")`, label `Custom ACP`, icon can reuse `ACPRegistryIcon` or a neutral plug icon.
  - `settingsSchema: CustomAcpSettings`.
- Add it to active `PROVIDER_CLIENT_DEFINITIONS`, not `COMING_SOON_DRIVER_OPTIONS`.
- Leave existing `acpRegistry` coming-soon option untouched.
- Consider adding `customAcp` to `PROVIDER_OPTIONS` in `apps/web/src/session-logic.ts` if any legacy picker path still depends on that static list.

### Server driver/provider
- Add `apps/server/src/provider/Drivers/CustomAcpDriver.ts` and register in `builtInDrivers.ts`.
- Do not add a legacy mirror in `deriveProviderInstanceConfigMap`; registration alone lets explicit `providerInstances` work. Runtime lookup of legacy settings should see `undefined` and skip synthetic default.
- Driver env likely needs: `ChildProcessSpawner`, `FileSystem`, `Path`, `ServerConfig`, `ProviderEventLoggers`; maybe no `HttpClient`.
- Build a `ProviderInstance` with:
  - `driverKind = customAcp`.
  - snapshot via a new `CustomAcpProvider`/`makeManagedServerProvider`.
  - adapter via a generic ACP adapter (below).
  - textGeneration via generic ACP text-generation adapter (below), because `ProviderInstance` requires it and the app uses provider instances for title/git text generation.

### Generic ACP runtime changes
- Modify `AcpSessionRuntimeOptions.authMethodId` to be optional.
- In `startOnce`, call `authenticate` only when `authMethodId` is non-empty.
- Preserve current behavior for Cursor by passing `cursor_login` explicitly.
- Consider adding options for `mcpServers` and maybe `sessionSetupMode` later; non-goal for first pass.
- Preserve existing session update parsing/event queue behavior.

### Generic ACP adapter
- Avoid copying all Cursor-specific logic blindly. Prefer extracting a reusable generic adapter core from `CursorAdapter.ts` or creating `apps/server/src/provider/acp/GenericAcpAdapter.ts` that is parameterized by:
  - provider driver kind and instance id,
  - settings/launch resolver,
  - extension registrations,
  - model-selection strategy,
  - snapshot/runtime logging labels.
- The initial implementation may copy the Cursor adapter lifecycle to reduce risk, but should isolate Custom ACP-specific pieces in small modules so later Cursor refactor can converge.
- Must implement the full `ProviderAdapterShape`:
  - `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `readThread`, `rollbackThread`, `stopSession`, `listSessions`, `hasSession`, `stopAll`, `streamEvents`.
- Reuse Cursor adapter patterns for:
  - per-thread lock,
  - `Scope` lifetime per session,
  - pending approvals map,
  - pending user inputs map,
  - `session.started`, `session.state.changed`, `thread.started`, `turn.started`, `turn.completed` events,
  - active assistant segment/content delta/tool call/plan event mapping via `AcpCoreRuntimeEvents.ts`,
  - stale pending request behavior on interrupt/stop.
- Provider emitted events must use `provider: customAcp`; `ProviderService` will stamp `providerInstanceId`.
- Resume cursor should be versioned separately from Cursor, e.g. `{ schemaVersion: 1, provider: "customAcp", sessionId }`, and parser should reject incompatible shapes.

### Ask-question extension module
- Add a generic module, e.g. `apps/server/src/provider/acp/AskQuestionExtension.ts`:
  - Schema for Cursor-compatible request with optional `toolCallId`/`title` and questions.
  - Normalize to `ReadonlyArray<UserInputQuestion>`.
  - If a question has no options, provide a fallback `OK` option as Cursor code does.
  - Multi-select maps from `allowMultiple === true`.
- Adapter registration:
  - If enabled and method non-empty, call `runtime.handleExtRequest(method, AskQuestionRequest, handler)` before `runtime.start()`.
  - Handler emits `user-input.requested`, waits on Deferred, emits `user-input.resolved`, returns `{ answers }`.
  - `respondToUserInput` resolves the matching Deferred; unknown/stale request returns `ProviderAdapterRequestError` with detail including `unknown pending user-input request` so existing UI cleanup works.

### Snapshot/model discovery
- Add `apps/server/src/provider/Layers/CustomAcpProvider.ts` or equivalent.
- Initial snapshot should be fast and not block too long:
  - disabled -> disabled snapshot,
  - empty/missing command -> error/unavailable-like ready snapshot with clear message,
  - otherwise “Checking Custom ACP availability...” then refresh.
- Check/probe can spawn ACP runtime and call `start()` with configured command/cwd, optional auth, minimal capabilities.
- Use `initializeResult.agentInfo` if available for version/name/auth display; auth status likely `unknown` unless auth flow result provides better signal.
- Discover models from `started.sessionSetupResult.configOptions`:
  - find option with category `model`, type `select`, flatten groups/options.
  - each option -> `ServerProviderModel { slug: value, name, isCustom: false, capabilities: EMPTY_CAPABILITIES }`.
  - append manual models from settings as `isCustom: true`.
  - if none, include a fallback model slug like `default` so T3 can send turns using backend default.
- No Cursor-specific capability derivation or parameterized model picker.

### Generic ACP text generation
- `ProviderInstance` requires `textGeneration`; implement generic variant based on `apps/server/src/textGeneration/CursorTextGeneration.ts`.
- Use the configured generic ACP runtime, collect `agent_message_chunk` text via `handleSessionUpdate`, prompt with structured JSON instructions from existing `TextGenerationPrompts.ts`, parse with `extractJsonObject`, sanitize with existing utils.
- Set model with `runtime.setModel(input.modelSelection.model)` when provided. Ignore provider-specific option selections for now.
- Timeout similar to Cursor (`180_000ms`) is acceptable.

## Non-goals for first pass
- Do not implement Pi ACP adapter itself.
- Do not implement upstream-style public ACP marketplace/registry.
- Do not implement dynamic arbitrary extension mapping in settings beyond ask-question method name.
- Do not implement fs/terminal ACP client capabilities/handlers.
- Do not implement Cursor plan/todo extensions unless the planner chooses them as a small opportunistic add-on.
- Do not replace/refactor Cursor provider wholesale; keep Cursor behavior stable.
- Do not make `customAcp` a legacy default provider unless explicitly desired later.

## Risks/tradeoffs
- Generic ACP probing requires creating/loading a session, which can have backend side effects. Cursor already does this for model discovery; keep timeouts and clear logs.
- Skipping auth when `authMethodId` is blank means auth-required agents may fail at session creation with a protocol error. This is intentional and explicit.
- Textarea args parsing can be a source of quoting bugs. Add unit tests for newline-separated args, quoted args, empty lines/comments if supported, and Windows-ish paths.
- Existing provider settings UI only supports primitive string/boolean fields. Rich model/env arrays need parsing from text.
- Copying CursorAdapter too literally risks coupling; extraction is cleaner but may expand scope. The implementation plan should choose a phased approach if necessary.
- Upstream may later add its own ACP registry. Using `customAcp` avoids storage and UI collision.

## Suggested validation
- Follow repo requirement: `bun fmt`, `bun lint`, `bun typecheck` before done. Use `bun run test` if tests are run; never `bun test`.
- Add focused tests for:
  - `AcpSessionRuntime` optional auth: no `authenticate` call when omitted, still calls when provided.
  - args/env parsing helpers.
  - ask-question schema normalization and response flow.
  - provider instance hydration recognizes `customAcp` explicit entries and does not require a legacy `providers.customAcp` key.
  - generic model discovery from ACP config option groups.
- If possible, add an ACP mock backend test using existing `packages/effect-acp/test/fixtures/acp-mock-peer.ts` patterns or server-side tests mirroring `CursorAdapter.test.ts`.

## Remaining open questions
None blocking. Defaults like exact `command`/`args` placeholder can be settled in planning/implementation; recommended UI placeholders should mention examples such as `pi ...` and `agent acp`, but avoid Cursor-only behavior in runtime defaults where possible.
