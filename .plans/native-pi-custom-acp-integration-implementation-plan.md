# Native Pi + Custom ACP integration implementation plan

Authoritative discovery brief: `.local/t3code/.plans/native-pi-custom-acp-integration-implementation-brief.md`.

Each phase worker must read that brief before editing and fit low-level implementation decisions to its instructions. The brief is the source of truth for exact source files to port, rejected branch changes, behavioral requirements, and validation targets.

## Global constraints

- Base the work on `.local/t3code` branch `feature/native-pi-provider`; create a new integration branch from it only after preserving the current dirty/ahead native-Pi work.
- Do not merge `custom-acp`. Port selectively from it and manually reconcile shared files so `pi` and `customAcp` coexist.
- Keep native Pi as native Pi: `driverKind: "pi"`, `PiSettings`, Pi RPC adapter, existing provider instance IDs, and existing Pi workflow behavior must remain intact.
- Add Custom ACP as a separate first-class provider: `driverKind: "customAcp"`, `CustomAcpSettings`, generic ACP stdio runtime, explicit provider instances only.
- Exclude Grok/XAI, cloud/settings layout rewrites, broad timeline/session UI changes, docs churn, and any unrelated custom-acp branch changes unless a compile/test failure proves they are required.
- No migration from `pi` to `customAcp`; no automatic duplication; no legacy default-provider behavior for Custom ACP unless existing hydration code makes it unavoidable.
- Automated validation only: `vp check`, `vp run typecheck`, and targeted tests. Do not add manual Pi/pi-acp/browser smoke as a completion requirement.

## Phase 0 — Branch hygiene and diff guardrails — done

Summary: Created `integration/native-pi-plus-custom-acp` from `feature/native-pi-provider`; preserved native-Pi state via backup branch `preserve/native-pi-provider-pre-custom-acp-20260619-163934` at `48f6559053bf80b7b2170969dfc6cc5b5a5821f9` and stash commit `082f7d843db302dbaafb07cbe229635407ba93cc`; no tracked source files dirty.

Goal: establish a merge-safe workspace before code changes.

- Preserve the current dirty/ahead native-Pi work by committing, stashing, or using a separate worktree; do not overwrite the listed modified/untracked Pi files from the brief.
- Create an integration branch from `feature/native-pi-provider`.
- Record a diff guardrail before implementation: the integration branch may touch Custom ACP, ACP runtime/support, provider registry, contracts/settings/model exports, text generation, and provider settings UI metadata/tests; it must not import unrelated `custom-acp` branch changes.

Exit criteria:

- Working branch is clean enough for surgical edits.
- Implementers can compare against `custom-acp` without performing a branch merge.

## Phase 1 — Contracts and provider metadata surface — done

Summary: Commit `3791ed2c` added `CustomAcpSettings`, model defaults/display name, provider metadata/test coverage, and preserved explicit-instance-only behavior; targeted tests and typecheck passed, `pnpm exec vp check` failed only on pre-existing untouched formatting in `packages/client-runtime/src/wsRpcProtocol.ts`.

Goal: make `customAcp` representable everywhere provider instances, settings schemas, model defaults, and client metadata require it, without changing native Pi semantics.

- Add the Custom ACP settings schema and exports while preserving the existing `PiSettings` and `providers.pi` behavior.
- Reconcile model defaults/display names so both `pi` and `customAcp` have explicit entries where required by current model-resolution code.
- Keep `ProviderDriverKind` open and provider-instance driven; do not introduce closed unions or migration assumptions.
- Update contract and metadata tests to prove both providers survive decoding, defaults, patching, and provider-instance round trips.

Primary validation targets:

- `packages/contracts/src/settings.test.ts`
- `packages/contracts/src/providerInstance.test.ts`
- Any model tests covering defaults/display names.
- Provider registry/hydration tests touched by settings/default changes.

## Phase 2 — Shared ACP runtime capabilities — done

Summary: Commits `712c6fb9` and `ba3634a3` added shared ACP capabilities, optional auth, available commands, usage, ask-question, session import, generic adapter mode, Pi workflow extension plumbing, and a Cursor reasoning stream regression fix; targeted ACP/Cursor tests and typecheck passed, full check remains blocked by unrelated `wsRpcProtocol.ts` formatting.

Goal: port the Custom ACP-required ACP support without regressing Cursor ACP or native Pi.

- Port only the ACP support modules required by the brief: available commands, usage, ask-question extension, Custom ACP support/session import, generic adapter mode, and Pi workflow extension.
- Reconcile shared ACP runtime files by applying only behavior Custom ACP needs, especially optional authentication and extension/event plumbing.
- Preserve Cursor behavior by requiring Cursor paths to pass their explicit auth method; blank auth should skip `authenticate` only for Custom ACP-style configuration.
- Keep ACP client capabilities minimal; do not add fs/terminal capability support unless the ported code requires disabled stubs.
- Keep Pi workflow ACP extension support scoped to existing `_pi/workflows/*` metadata/resume behavior, not as a new UI transport.

Primary validation targets:

- `AcpSessionRuntime.test.ts`
- `AcpAvailableCommands.test.ts`
- `AcpUsage.test.ts`
- `AskQuestionExtension.test.ts`
- `CustomAcpSupport.test.ts`
- `CustomAcpSessionImport.test.ts`
- `PiWorkflowExtension.test.ts`
- Existing Cursor ACP runtime/support tests.

## Phase 3 — Custom ACP server driver, adapter, and text generation — done

Summary: Commits `9022c694` and `1eff0efb` added `CustomAcpDriver`, provider/runtime adapter, text generation, mock-agent support, registry wiring, and interrupt/stale-turn fixes; targeted Custom ACP/provider/text-generation tests and typecheck passed, while `ProviderRegistry.test.ts` has unrelated env-sensitive failures and full check is still blocked by untouched `wsRpcProtocol.ts` formatting.

Goal: add runtime support for Custom ACP provider instances through existing provider abstractions.

- Port the Custom ACP driver/provider layer, generic ACP adapter, and Custom ACP text generation from `custom-acp`.
- Register `CustomAcpDriver` alongside `PiDriver`; do not register Grok or any unrelated driver.
- Ensure Custom ACP snapshots, model discovery, slash commands, ask-question handling, resume/import behavior, usage, and text generation flow through the existing provider runtime contracts.
- Treat `command` as the runtime availability boundary: empty/unavailable configuration should produce an unavailable/error snapshot rather than crashing or probing native Pi.
- Keep Custom ACP continuation/session identity separate from native Pi identity and provider instance routing.

Primary validation targets:

- `CustomAcpProvider.test.ts`
- Portable Generic ACP adapter tests from `custom-acp`
- `ProviderRegistry.test.ts`
- `ProviderInstanceRegistryLive.test.ts`
- Text generation tests for registry dispatch and Custom ACP output sanitization.

## Phase 4 — Web settings integration — done

Summary: Commit `aea3e80e` added explicit web provider metadata/form test coverage for `pi` and `customAcp`, preserving Pi metadata and excluding unrelated drivers; targeted web unit test and typecheck passed, full check still blocked by untouched `wsRpcProtocol.ts` formatting.

Goal: expose Custom ACP as a selectable provider driver without broad UI churn.

- Add Custom ACP to the browser-safe provider driver metadata with its settings schema and a minimal icon choice.
- Preserve the existing Pi metadata exactly enough that native Pi remains selectable/configurable as before.
- Update generic provider settings form tests to cover Custom ACP fields and keep Pi coverage.
- Avoid porting `custom-acp` branch settings-layout, cloud, timeline, or session UI changes unless current tests or real picker paths require a narrow adjustment.

Primary validation targets:

- `apps/web/src/components/settings/ProviderSettingsForm.test.ts`
- Settings panel/provider picker tests only if touched.

## Phase 5 — Integration validation and review cleanup — done

Summary: No cleanup commit needed. Targeted contracts/model, ACP support, Custom ACP provider/text generation, provider hydration, and web settings tests passed, and `pnpm exec vp run typecheck` passed. Scope review found no Grok/XAI/cloud/docs/timeline/settings-layout leakage. `pnpm exec vp check` still fails only on untouched `packages/client-runtime/src/wsRpcProtocol.ts` formatting; `ProviderRegistry.test.ts` has unrelated Windows/env-sensitive failures in untouched code; a CursorAdapter targeted run timed out in a pre-existing mock ACP prompt-flow test.

Goal: make the branch merge-safe and prove scope control.

- Run targeted tests from the brief for contracts, provider registry/hydration, ACP support, Custom ACP provider/adapter/text generation, and web settings metadata/form.
- Run the repository completion checks required by `.local/t3code/AGENTS.md`: `vp check` and `vp run typecheck`.
- Review the final diff against `custom-acp` and `feature/native-pi-provider`; remove any Grok/XAI/unrelated UI/docs/cloud changes that slipped in.
- Confirm final behavior at the contract level: native Pi remains `pi`; Custom ACP is `customAcp`; no migration or cross-provider sharing was added.

Exit criteria:

- All required automated checks pass or any failures are documented as pre-existing/unrelated with evidence.
- Diff is logically split enough for review, preferably matching the commit boundaries recommended in the brief.
