# Native Pi + Custom ACP T3Code integration — implementation discovery brief

## Clarified objective
Create a safe integration plan/branch for `.local/t3code` that keeps the current native Pi provider and adds the stable Custom ACP provider as a separate first-class provider. The target state is that T3Code can offer both:

- Native Pi provider: `driverKind: "pi"`, `PiSettings`, launches `pi --mode rpc` directly through the native Pi RPC adapter.
- Custom ACP provider: `driverKind: "customAcp"`, `CustomAcpSettings`, launches an ACP backend such as `.local/pi-acp/dist/index.js` over ACP stdio.

The user wants the next step to write a plan for a merge-safe new branch. Implementation may happen later in the workflow, but this discovery handoff is for planning.

## Decisions made with the user
1. **Base branch:** create the integration branch from `.local/t3code` branch `feature/native-pi-provider`; port Custom ACP into it. Do not base on `custom-acp`.
2. **Scope:** minimal Custom ACP only. Include the `customAcp` driver, generic ACP adapter, ask-question support, slash commands, Pi workflow ACP extension, Custom ACP text generation, and required contracts/UI metadata. Exclude Grok/XAI and unrelated UI/docs/cloud changes from `custom-acp`.
3. **Migration policy:** no automatic migration. Existing native Pi settings/provider instances remain `driver: "pi"`; users add Custom ACP separately as `driver: "customAcp"`.
4. **Validation bar:** automated only before declaring branch merge-safe: `vp check`, `vp run typecheck`, plus targeted provider/contract/web tests. No required manual Pi/pi-acp smoke in this plan.

## Current repository/branch facts
- Current T3Code branch: `feature/native-pi-provider...origin/feature/native-pi-provider [ahead 4]`.
- Worktree has dirty native-Pi files. Do not begin branch surgery until these are committed, stashed, or moved to a worktree.
  - Modified: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.{ts,test.ts}`, `apps/server/src/provider/Layers/PiAdapter.test.ts`, `PiWorkflowMapper.ts`, `PiWorkflowMonitor.ts`.
  - Untracked: `PiWorkflowMapper.test.ts`, `PiWorkflowMonitor.test.ts`.
- Common ancestor of `feature/native-pi-provider` and `custom-acp`: `0e4a43519fe4fa85ce60aa8d6d53c067e56d2fca`.
- A dry-run merge shows many conflicts outside the desired scope. Avoid blind merging `custom-acp`.

## Why a normal merge is risky
The two branches diverged in shared infrastructure, not only in provider files. Conflicts/overlap include:

- `apps/server/src/provider/builtInDrivers.ts` — native branch registers `PiDriver`; custom branch registers `CustomAcpDriver` plus `GrokDriver`.
- `packages/contracts/src/settings.ts` — native branch has `PiSettings` and `providers.pi`; custom branch has `CustomAcpSettings` and Grok-related settings but no Pi.
- `packages/contracts/src/model.ts` — native branch defines Pi defaults/display name; custom branch defines Grok defaults/display name. Need combine Pi + Custom ACP, not take either side wholesale.
- `packages/contracts/src/providerRuntime.ts` — both branches changed runtime event contracts; native branch currently already has `user-input.*` and token usage types needed by Custom ACP.
- `apps/web/src/components/settings/providerDriverMeta.ts` — native branch exposes Pi UI metadata; custom branch exposes Custom ACP + Grok metadata.
- Web session/timeline/settings files and docs have unrelated conflicts and should not be ported unless directly required.

## Existing native branch state relevant to Custom ACP
Native branch already has an ACP runtime subset under `apps/server/src/provider/acp/`:

- Present: `AcpSessionRuntime.ts`, `AcpRuntimeModel.ts`, `AcpCoreRuntimeEvents.ts`, `AcpJsonRpcConnection.ts`, `AcpNativeLogging.ts`, `CursorAcpExtension.ts`, `CursorAcpSupport.ts` and tests.
- Missing relative to `custom-acp`: `AcpAvailableCommands`, `AcpUsage`, `AskQuestionExtension`, `CustomAcpSupport`, `CustomAcpSessionImport`, `GenericAcpAdapterMode`, `PiWorkflowExtension`, plus tests.
- Current `AcpSessionRuntimeOptions.authMethodId` is required and startup always calls `authenticate`. Custom ACP needs auth to be optional/blank-skippable while preserving Cursor behavior by passing `cursor_login` explicitly.
- Current ACP session setup hardcodes `mcpServers: []`, acceptable for this integration.

## Custom ACP branch pieces to port selectively
Port from `custom-acp` with manual reconciliation against current native files:

### Server provider/driver
- `apps/server/src/provider/Drivers/CustomAcpDriver.ts`
- `apps/server/src/provider/Layers/CustomAcpProvider.ts`
- `apps/server/src/provider/Layers/CustomAcpProvider.test.ts`
- `apps/server/src/provider/Layers/GenericAcpAdapter.ts`
- Relevant tests for Generic ACP behavior if present/portable.
- Register `CustomAcpDriver` in `apps/server/src/provider/builtInDrivers.ts` alongside `PiDriver`; do not include `GrokDriver`.

### ACP support modules
- `apps/server/src/provider/acp/AcpAvailableCommands.{ts,test.ts}`
- `apps/server/src/provider/acp/AcpUsage.{ts,test.ts}`
- `apps/server/src/provider/acp/AskQuestionExtension.{ts,test.ts}`
- `apps/server/src/provider/acp/CustomAcpSupport.{ts,test.ts}`
- `apps/server/src/provider/acp/CustomAcpSessionImport.{ts,test.ts}` if required by Generic ACP session import/list/resume behavior.
- `apps/server/src/provider/acp/GenericAcpAdapterMode.ts`
- `apps/server/src/provider/acp/PiWorkflowExtension.{ts,test.ts}` because the requested minimal scope includes Pi workflow ACP extension support.
- Do **not** port `GrokAcpSupport`, `GrokAcpCliProbe`, `XAiAcpExtension`, or Grok tests.

### Text generation
- `apps/server/src/textGeneration/CustomAcpTextGeneration.ts`
- Reconcile `apps/server/src/textGeneration/TextGeneration.ts` type unions if needed. Native branch currently has `TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "opencode" | "pi"`; Custom ACP text generation may require adding `"customAcp"` or the type may remain unused by driver instances. Planner/implementer should verify.

### Contracts/settings/model exports
- Add `CustomAcpSettings` to `packages/contracts/src/settings.ts` while preserving `PiSettings` and `providers.pi`.
- Export Custom ACP settings through `packages/contracts/src/index.ts` if required.
- Add settings tests from `custom-acp`, adjusted to expect both Pi and Custom ACP schemas.
- Recommended `CustomAcpSettings` fields from branch:
  - `enabled` hidden boolean default `true`
  - `command` string, default empty; clear unavailable/error snapshot if empty
  - `args` textarea string; newline/shell-like parsing in runtime helper
  - `env` textarea string; `KEY=value` lines
  - `authMethodId` string; blank skips ACP `authenticate`
  - `askQuestionEnabled` boolean default `true`
  - `askQuestionMethod` string default `cursor/ask_question`
  - `manualModels` textarea string; newline/comma fallback model ids
  - `clientCapabilitiesMetaJson` textarea string; optional JSON object merged into ACP initialize `clientCapabilities._meta`
- Update `packages/contracts/src/model.ts` to include both native Pi and Custom ACP defaults/display names. Recommended Custom ACP defaults: model `default`, git text generation model `default`, empty aliases, display name `Custom ACP`.
- Avoid legacy migration/default-provider behavior for Custom ACP unless required by existing hydration code. Preferred: explicit `providerInstances` only.

### Web UI metadata
- Update `apps/web/src/components/settings/providerDriverMeta.ts` to expose both providers:
  - Existing Pi entry remains: `ProviderDriverKind.make("pi")`, `PiIcon`, `PiSettings`.
  - Add Custom ACP entry: `ProviderDriverKind.make("customAcp")`, label `Custom ACP`, `CustomAcpSettings`.
- Port/add `CustomAcpIcon` from `custom-acp` only if isolated; otherwise reuse a neutral existing icon to avoid unrelated icon conflicts. Do not port Grok icon.
- Adjust `ProviderSettingsForm.test.ts` for Custom ACP fields while keeping Pi tests.
- Only modify broader settings/session UI files if tests or actual picker paths require it. Avoid wholesale `custom-acp` versions of cloud/settings layout/session timeline files.

## Behavioral requirements for Custom ACP
- Custom ACP and native Pi must coexist as independent provider instances. They must not share driver kind, settings schema, provider instance IDs, resume cursors, or transport assumptions.
- Native Pi continues to use Pi RPC and Pi settings; Custom ACP uses ACP stdio and can point at `pi-acp`, Cursor ACP, or another compatible ACP backend.
- Custom ACP ask-question handling defaults to Cursor-compatible `cursor/ask_question`, because `.local/pi-acp` translates Pi RPC dialogs to that ACP extension for T3Code Custom ACP compatibility.
- ACP auth is optional. If `authMethodId` is blank, skip `authenticate`; if non-empty, call `authenticate({ methodId })`. Cursor behavior must remain unchanged by passing its auth method explicitly.
- Slash commands should be derived from ACP `available_commands_update` and surfaced on the provider snapshot when available. The custom branch notes latest session update wins at provider-instance scope.
- Pi workflow ACP extension support should be included only insofar as required by existing `pi-acp` private `_pi/workflows/*` metadata/resume behavior; do not use it as a UI transport beyond the existing T3/provider runtime contracts.
- Text generation for Custom ACP should use the generic ACP runtime and return sanitized JSON outputs as in branch code.

## Non-goals
- Do not implement or change `.local/pi-acp`; only T3Code integration is in scope.
- Do not change Pi core/native provider behavior except where shared ACP runtime changes require it.
- Do not merge the full `custom-acp` branch.
- Do not port Grok/XAI provider support.
- Do not add automatic migration/duplication from native Pi provider to Custom ACP provider.
- Do not make Custom ACP a legacy default provider unless absolutely required; prefer explicit provider instances.
- Do not implement ACP fs/terminal client capabilities as part of this integration unless existing Custom ACP code requires stubbing them disabled.
- Do not require manual browser/Pi smoke for merge-safety in this plan.

## Implementation constraints and safe branch strategy
1. Preserve or isolate current dirty native-Pi work before branch creation.
2. Create new branch from `feature/native-pi-provider`, e.g. `integration/native-pi-plus-custom-acp`.
3. Prefer surgical checkout/cherry-pick of files from `custom-acp` over Git merge:
   - Use `git checkout custom-acp -- <new-file>` for files with no native counterpart.
   - Manually edit shared files (`settings.ts`, `model.ts`, `builtInDrivers.ts`, `providerDriverMeta.ts`, tests) to combine both branches.
   - For shared ACP files (`AcpSessionRuntime.ts`, `AcpRuntimeModel.ts`, `AcpCoreRuntimeEvents.ts`), diff custom branch against native and port only Custom ACP-required changes.
4. Keep commits logically split for review:
   - contracts/settings/model support
   - ACP runtime/support modules
   - Custom ACP driver/provider/text generation
   - web UI metadata/settings form
   - tests/validation fixes
5. Avoid introducing branch-wide unrelated changes from `custom-acp` to docs, cloud settings, Grok, XAI, broad chat timeline UI, or workspace search unless a compile/test failure proves they are required.

## Validation plan requested by user
Automated-only validation is the acceptance bar:

- Required repo checks per `.local/t3code/AGENTS.md`:
  - `vp check`
  - `vp run typecheck`
- Targeted tests to include/run as available:
  - Contracts: `packages/contracts/src/settings.test.ts`, `packages/contracts/src/model*` if present.
  - Provider registry/hydration: `ProviderRegistry.test.ts`, `ProviderInstanceRegistryLive.test.ts`, any provider instance config tests touched.
  - ACP runtime/support: `AcpSessionRuntime.test.ts`, `AcpAvailableCommands.test.ts`, `AskQuestionExtension.test.ts`, `CustomAcpSupport.test.ts`, `PiWorkflowExtension.test.ts`, `AcpUsage.test.ts`.
  - Custom ACP provider/adapter/text generation tests ported from branch.
  - Web settings metadata/form tests: `ProviderSettingsForm.test.ts`, `SettingsPanels.logic.test.ts` if touched.
- Do not use `bun test` unless repo docs explicitly change; `.local/t3code/AGENTS.md` says use `vp` commands.

## Risks and tradeoffs
- **Conflict risk:** shared contracts/runtime/UI files will compile but may subtly prefer one branch's assumptions. Tests should assert both `pi` and `customAcp` entries survive.
- **ACP auth risk:** making auth optional changes a shared runtime. Preserve Cursor behavior with explicit auth and add regression tests.
- **Provider defaults risk:** `custom-acp` branch did not have native Pi and native branch did not have Custom ACP; defaults/display names/settings provider map need manual combination.
- **Text generation risk:** Custom ACP text generation spawns a backend and may behave differently with pi-acp vs other ACP servers. Automated mock tests should cover protocol shape; no manual smoke required by user.
- **Ask-question extension is Cursor-compatible, not stable ACP:** keep it explicitly configurable and labeled extension behavior, not a universal ACP contract.
- **Side-effect risk in provider probes:** Custom ACP status/model discovery may create ACP sessions. Keep branch timeouts and clear unavailable/error snapshots.
- **Windows process behavior:** current `AcpSessionRuntime` uses `shell: process.platform === "win32"`; args parsing/command launching should be tested enough to avoid breaking local Windows usage.

## Open questions
None blocking after user decisions. The planner may choose exact branch name and commit breakdown. Exact Custom ACP icon choice can be settled during implementation; prefer minimal/no-conflict asset changes.
