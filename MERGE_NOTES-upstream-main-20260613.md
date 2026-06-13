# Upstream main merge notes — 2026-06-13

Integration branch: `merge/upstream-main-20260613`
Base branch: `merge/upstream-main-20260607`
Merge command: `git merge --no-ff upstream/main`
Phase status: Phase 6 whole-merge cleanup and compatibility validation complete; manual smoke remains for Phase 7/review before promotion.

## Recorded SHAs after fresh fetch

- `HEAD` before integration branch: `3b3f7567dde850af37259b48ad4dcc604037d281`
- Previous merge branch `merge/upstream-main-20260607`: `3b3f7567dde850af37259b48ad4dcc604037d281`
- `origin/merge/upstream-main-20260607`: `3b3f7567dde850af37259b48ad4dcc604037d281`
- `origin/custom-acp`: `0adbb9ebb0ca5e71a219ac93ff6b05dfa53fea01`
- `upstream/main` / `MERGE_HEAD`: `d25090cf6d2f334668bf1cba75b6ce3d78beb237`
- Merge base of `merge/upstream-main-20260607` and `upstream/main`: `3ea6adf17d5528d9c90ed53b6dead650d5931941`

Incoming range: `3ea6adf17d5528d9c90ed53b6dead650d5931941..d25090cf6d2f334668bf1cba75b6ce3d78beb237` (`29` commits).

## Incoming commits

- `0e4a4351` `[codex] Extract infrastructure, telemetry, and test tooling (#2994)`
- `38ea6d48` `feat(grok): add Grok CLI provider via ACP (#2809)`
- `8e6f4229` `[codex] Fix main CI Effect test runtimes (#3008)`
- `de58ec8e` `Add Claude Fable 5 model (#3009)`
- `983a8c7f` `chore(release): prepare v0.0.26`
- `22f9f305` `[codex] Rebrand T3 Cloud as T3 Connect (#3011)`
- `a3422a9b` `Fix Clerk browser test mock (#3013)`
- `04f7f32a` `chore(release): prepare v0.0.27`
- `aca14507` `Bundle DM Sans and JetBrains Mono fonts instead of Google Fonts (#3014)`
- `b03bc4b5` `Mute icons in labeled controls and suppress popup focus rings (#3015)`
- `238715fd` `Polish dialog/alert surfaces and unauthenticated provider banner (#3016)`
- `cc9e81ac` `fix(marketing) : marketing showing wrong icons on linux (#2696)`
- `7f741a56` `Misc markdown styling improvements (#3017)`
- `31533466` `Model picker UI Improvements, Virtualize Model List (#3021)`
- `e2db800f` `Provider env vars table and reworked accent color picker (#3026)`
- `c5f7cd40` `Polish branch picker trigger, scroll fade, and list layout (#3024)`
- `3efabdcd` `Polish web context menu fallback and sidebar icon actions (#3025)`
- `a4757c26` `Composer polish: focus ring, send/stop buttons, command menu, context meter, answer panel (#3018)`
- `0b40ea62` `Extract changed files card with compact aligned diff stats (#3023)`
- `343061a0` `Misc chrome polish: header badges, plan sidebar, diff panel, empty state (#3027)`
- `1916ac6d` `Rework message metadata, timestamps, and tool work log rows (#3022)`
- `ae7e88b0` `[codex] Sync app-server protocol, service tiers, and provider startup (#3036)`
- `0baf1986` `[codex] Reduce Git status polling churn (#3037)`
- `57f6bf7e` `Fix turn fold proejctions (#3041)`
- `7db03490` `fix(git): disable external diff for patch output (#2553)`
- `649f4328` `[codex] Refine inline tool call timeline UI (#3052)`
- `1ea17026` `[codex] fix slow websocket shutdown (#2869)`
- `ae39bacf` `Handle non-resumable pending user input (#2766)`
- `d25090cf` `fix: avoid sending composer during IME enter (#2817)`

## Conflict inventory

Fresh merge conflict set matches the 16-file set expected by the plan:

- `apps/server/scripts/acp-mock-agent.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- `apps/web/src/components/ChatMarkdown.tsx`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/chat/ContextWindowMeter.tsx`
- `apps/web/src/components/chat/MessagesTimeline.browser.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/providerIconUtils.ts`
- `apps/web/src/components/settings/providerDriverMeta.ts`
- `apps/web/src/lib/contextWindow.ts`
- `apps/web/src/session-logic.ts`

## Phase 1 validation

Commands run:

- `git fetch origin`
- `git fetch upstream`
- `git switch -c merge/upstream-main-20260613 merge/upstream-main-20260607`
- `git merge --no-ff upstream/main` exited `1` with expected conflicts.
- `git diff --name-only --diff-filter=U` returned exactly the 16 paths listed above.

`git status --short` shows the normal upstream merge additions/modifications/deletions plus only the expected unmerged `UU` paths listed above. This notes file is the only new local Phase 1 file.

## Phase 2 server/provider conflict resolution

Resolved the server/provider conflicts only:

- `apps/server/src/provider/builtInDrivers.ts` now registers both `CustomAcpDriver` and upstream `GrokDriver`; `BuiltInDriversEnv` includes both driver env unions.
- `apps/server/scripts/acp-mock-agent.ts` preserves the Custom ACP/Pi mock surfaces (session list/load, Pi steering/workflows/replay, available commands, cancellation hangs, prompt failure knobs, request/exit logging) while adding upstream Grok/xAI model state, `session/set_model`, `_x.ai/ask_user_question`, prompt delay, and configurable permission option IDs.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` keeps Custom ACP delivery/cancel regression coverage, adds the upstream provider-registry runtime requirement to the test harnesses, and waits for first-message delivery in the upstream new-thread-required model-switch test so it remains compatible with the Custom ACP undelivered-message guard.

Phase 2 validation:

- `pnpm exec vp test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AskQuestionExtension.test.ts apps/server/src/provider/acp/CursorAcpExtension.test.ts apps/server/src/provider/acp/PiWorkflowExtension.test.ts apps/server/src/provider/acp/CustomAcpSessionImport.test.ts apps/server/src/provider/acp/CustomAcpSupport.test.ts apps/server/src/provider/acp/GrokAcpSupport.test.ts apps/server/src/provider/acp/XAiAcpExtension.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts apps/server/src/provider/Layers/CustomAcpProvider.test.ts apps/server/src/provider/Layers/GrokProvider.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts` passed (`14` files / `196` tests).
- `pnpm exec vp run --filter t3 typecheck` still fails before later phases complete because server test files import missing `vitest` types (`AcpUsage.test.ts`, `AskQuestionExtension.test.ts`, `CustomAcpSupport.test.ts`) and an existing Effect diagnostics suggestion remains in `CursorAcpExtension.ts`; the Phase 2 ProviderCommandReactor missing-layer error was fixed.
- `pnpm exec vp fmt apps/server/scripts/acp-mock-agent.ts apps/server/src/provider/builtInDrivers.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` completed.
- `git diff --check -- apps/server/scripts/acp-mock-agent.ts apps/server/src/provider/builtInDrivers.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` completed with no whitespace errors.

## Phase 3 provider metadata/settings/context usage conflict resolution

Resolved the provider metadata and context usage conflicts only:

- `apps/web/src/components/chat/providerIconUtils.ts` now imports and maps both `CustomAcpIcon` and upstream `GrokIcon`.
- `apps/web/src/components/settings/providerDriverMeta.ts` now exposes both Custom ACP and Grok client definitions with their settings schemas and icons; the Custom ACP primitive settings form remains active while Grok keeps the upstream Early Access badge.
- `apps/web/src/lib/contextWindow.ts` keeps Custom ACP cost extraction from nested ACP `cost`, `costAmount`/`costCurrency`, and `totalCostUsd` payloads while adopting provider display-name formatting for composer/context-meter messaging. Added explicit `customAcp` and `grok` labels.
- `apps/web/src/components/chat/ContextWindowMeter.tsx` preserves the detailed Custom ACP token/cost/cache/model/source/request diagnostics and adds upstream provider-aware automatic compaction messaging plus the compact usage progress treatment.
- `apps/web/src/session-logic.ts` adopts upstream optional `WorkLogEntry.turnId` without removing Custom ACP/Pi `toolKind`/`acpTitle` extraction or lifecycle status handling. Added regression tests for no-turn ACP stopped/cancelled lifecycle rows and for preserving terminal non-success lifecycle status when a bare completion event collapses into the row.

Phase 3 validation:

- `pnpm exec vp fmt apps/web/src/components/chat/providerIconUtils.ts apps/web/src/components/settings/providerDriverMeta.ts apps/web/src/lib/contextWindow.ts apps/web/src/components/chat/ContextWindowMeter.tsx apps/web/src/session-logic.ts apps/web/src/lib/contextWindow.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts apps/web/src/session-logic.test.ts` completed.
- `cd apps/web && pnpm exec vp test run src/lib/contextWindow.test.ts src/session-logic.test.ts src/components/settings/ProviderSettingsForm.test.ts src/modelSelection.test.ts` passed (`4` files / `87` tests).
- `pnpm exec vp test run apps/web/src/lib/contextWindow.test.ts apps/web/src/session-logic.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts apps/web/src/modelSelection.test.ts` from repo root failed only for UI-importing suites because the direct root invocation did not resolve the web `~/lib/utils` alias; the same focused set passed from `apps/web`.
- `git diff --check -- apps/web/src/components/chat/providerIconUtils.ts apps/web/src/components/settings/providerDriverMeta.ts apps/web/src/lib/contextWindow.ts apps/web/src/components/chat/ContextWindowMeter.tsx apps/web/src/session-logic.ts apps/web/src/lib/contextWindow.test.ts apps/web/src/components/settings/ProviderSettingsForm.test.ts apps/web/src/session-logic.test.ts` completed with no whitespace errors.
- Double-check fix: `pnpm exec vp fmt apps/web/src/session-logic.ts apps/web/src/session-logic.test.ts` completed, and `cd apps/web && pnpm exec vp test run src/session-logic.test.ts` passed (`1` file / `60` tests).

## Phase 4 markdown/sidebar/ChatView conflict resolution

Resolved the Phase 4 web conflicts only:

- `apps/web/src/components/ChatMarkdown.tsx` uses upstream sanitized raw HTML, external-link favicon/tooltip handling, file-chip links, clipboard helpers, tables, details, and code-block chrome while preserving Custom ACP/Pi markdown path rewriting and inline-code path linking via `resolveMarkdownCodeSpanPathLinkMeta`. Double-check fix: raw HTML `<a href="file:...">` links now resolve through the same file-chip/preferred-editor path as markdown file links.
- `apps/web/src/components/ChatView.tsx` preserves the Custom ACP undelivered-message banner, send block, retry dispatch, and local-dispatch message acknowledgement while accepting upstream composer ref/send-context, type-to-focus, pending-input, and model-change-blocking fixes.
- `apps/web/src/components/ChatView.logic.test.ts` keeps undelivered-message coverage and includes upstream started-session model-change tests.
- `apps/web/src/components/Sidebar.tsx` keeps the Custom ACP external session import context-menu action and adopts the shorter upstream sidebar action labels.

Phase 4 validation:

- `pnpm exec vp fmt apps/web/src/components/ChatMarkdown.tsx apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/Sidebar.tsx` completed.
- `cd apps/web && pnpm exec vp test run src/components/ChatView.logic.test.ts src/components/Sidebar.logic.test.ts src/lib/customAcpSessionImport.test.ts src/localApi.test.ts` passed (`4` files / `101` tests).
- `cd apps/web && pnpm exec playwright install chromium` completed after browser tests first reported a missing Playwright browser.
- `cd apps/web && pnpm exec vp test run --project browser src/components/ChatMarkdown.browser.tsx src/components/ChatView.browser.tsx src/components/custom-acp/ImportAcpSessionDialog.browser.tsx` remains blocked by the intentionally unresolved Phase 5 `MessagesTimeline.browser.tsx`/`MessagesTimeline.tsx` conflict markers during Vite dependency scanning.
- `cd apps/web && pnpm exec vp test run --project browser src/components/ChatMarkdown.browser.tsx src/components/custom-acp/ImportAcpSessionDialog.browser.tsx` is also blocked by the same global browser dependency scan over unresolved Phase 5 timeline files.
- The undelivered retry UI test in `MessagesTimeline.test.tsx` remains deferred with Phase 5 because it imports the still-conflicted timeline component.
- Double-check fix validation: `pnpm exec vp fmt apps/web/src/components/ChatMarkdown.tsx apps/web/src/components/ChatMarkdown.browser.tsx` completed, and `cd apps/web && pnpm exec vp test run --project browser src/components/ChatMarkdown.browser.tsx` passed on retry (`1` file / `26` tests); the first browser run failed during Vite dependency optimization/reload before collecting tests.

## Phase 5 timeline/work-log conflict resolution

Resolved the Phase 5 timeline conflicts only:

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` adopts upstream settled-turn fold projection, latest-turn metadata/timestamp assumptions, and changed-files/review row metadata while keeping Custom ACP user delivery state projection and same-turn grouping for adjacent ACP/Pi work entries.
- Work-only Custom ACP/Pi progress rows without a terminal assistant message stay visible instead of being hidden behind a fold; interrupted latest turns still use upstream stopped-turn fold rows and latest-turn timings.
- `apps/web/src/components/chat/MessagesTimeline.tsx` keeps upstream message metadata/timestamps, turn-fold UI, pending/user-input tool statuses, and inline tool call refinements while preserving Custom ACP/Pi undelivered-message retry UI, compact common ACP tool labels, Pi thought/subagent rows, file path links, changed-file chips, workflow/tool metadata, and source/detail display.
- `apps/web/src/components/chat/MessagesTimeline.browser.tsx` keeps upstream work-row/fold browser coverage and the Custom ACP retry-related props.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` now covers upstream fold ordering/metadata plus Custom ACP delivery projection, changed-file/review ordering, same-turn work grouping, and Pi thought/tool metadata preservation.

Phase 5 validation:

- `vp fmt apps/web/src/components/chat/MessagesTimeline.logic.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.browser.tsx` completed.
- `vp run --filter @t3tools/web test -- src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx src/session-logic.test.ts` passed (`102` files / `1091` tests; Vite project filtering still scans the web unit set).
- `vp run --filter @t3tools/web test:browser -- src/components/chat/MessagesTimeline.browser.tsx` passed on retry (`12` files / `188` tests). The first run failed during Vite dependency optimization/reload in unrelated browser suites before the dependency cache stabilized.
- `vp run --filter @t3tools/web typecheck` still fails only on pre-existing missing `vitest` type imports in web test files (`ImportAcpSessionDialog.browser.tsx`, `fileLinkCandidate.test.ts`, `customAcpSessionImport.test.ts`, `markdown-code-path-links.test.ts`, `threadReadState.logic.test.ts`). No Phase 5 timeline type errors remain after the merge fixes.
- `git diff --check -- apps/web/src/components/chat/MessagesTimeline.logic.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.browser.tsx` completed with no whitespace errors.

## Phase 6 whole-merge cleanup and compatibility validation

Cleanup decisions and fixes:

- Rechecked conflict markers with `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- ':!pnpm-lock.yaml' ':!.repos/**' ':!**/node_modules/**' ':!**/vendor/**'`; none found.
- Ran targeted formatting on all resolved conflict files and `MERGE_NOTES-upstream-main-20260613.md`; `vp check --fix` then normalized `pnpm-workspace.yaml` formatting.
- Kept Playwright Chromium available from the Phase 4 install and reran browser coverage successfully; browser tests are not marked skipped.
- Changed new Custom ACP/Pi and Grok tests that imported `vitest`/`vitest/browser` directly to `vite-plus/test` and `vite-plus/test/browser`, matching the repo runner and avoiding extra `vitest` package dependencies.
- Fixed the full typecheck blocker in `packages/client-runtime/src/environmentConnection.ts` by replacing `console.warn` with `Effect.logWarning`.
- Adjusted new `ProviderCommandReactor.test.ts` and `projector.test.ts` Effect runner calls so the repository's no-net-new manual Effect runtime lint gate remains satisfied while preserving existing test behavior.
- Preserved the Phase 5 mixed Pi thought/tool compaction fix: same-turn Pi thought rows remain visible while only overflowing compactable tool rows collapse.

Phase 6 validation:

- `vp test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AskQuestionExtension.test.ts apps/server/src/provider/acp/CursorAcpExtension.test.ts apps/server/src/provider/acp/PiWorkflowExtension.test.ts apps/server/src/provider/acp/CustomAcpSessionImport.test.ts apps/server/src/provider/acp/CustomAcpSupport.test.ts apps/server/src/provider/acp/GrokAcpSupport.test.ts apps/server/src/provider/acp/XAiAcpExtension.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts apps/server/src/provider/Layers/CustomAcpProvider.test.ts apps/server/src/provider/Layers/GrokProvider.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/orchestration/projector.test.ts` passed (`15` files / `208` tests). An earlier run failed after temporarily adding direct `vitest` dependencies; reverting that approach and normalizing imports to `vite-plus/test` fixed runner resolution.
- `vp run --filter @t3tools/web test -- src/lib/contextWindow.test.ts src/session-logic.test.ts src/components/settings/ProviderSettingsForm.test.ts src/modelSelection.test.ts src/components/ChatView.logic.test.ts src/components/Sidebar.logic.test.ts src/lib/customAcpSessionImport.test.ts src/localApi.test.ts src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx src/markdown-code-path-links.test.ts src/fileLinkCandidate.test.ts src/threadReadState.logic.test.ts` passed (`102` files / `1092` tests; the web unit runner still scans the broader unit project).
- `vp run --filter @t3tools/web test:browser -- src/components/ChatMarkdown.browser.tsx src/components/ChatView.browser.tsx src/components/custom-acp/ImportAcpSessionDialog.browser.tsx src/components/chat/MessagesTimeline.browser.tsx` passed (`12` files / `188` tests). Vite re-optimized dependencies and warned about an unexpected reload, but the retry-stabilized run completed successfully.
- `vp check` passed with `0` errors and `11` existing `react(no-unstable-nested-components)` warnings.
- `vp run typecheck` passed all `15` packages. It still reports the existing Effect suggestion in `apps/server/src/provider/acp/CursorAcpExtension.ts` about replacing a `typeof ... .Type` query with `CursorAskQuestionRequest`; this is not a typecheck failure.

Manual smoke before promoting to `origin/custom-acp`:

- Launch Custom ACP/Pi provider session: not run.
- Verify external session list/import including outside-CWD filtering behavior: not run.
- Verify Pi workflow replay, pause/resume/abort, pause discovery cursors, and steering: not run.
- Verify cancellation/stop behavior does not complete duplicate turns and keeps recoverable sessions alive: not run.
- Verify ACP usage/context meter displays token details/cost/source metadata: not run.
- Verify timeline renders Pi thoughts, compact ACP tools, file links, changed files, pending input, and undelivered retry UI: not run.
- Verify Grok provider appears in settings/model picker and basic mock/provider tests cover its ACP model/config behavior: not run manually; focused automated Grok provider/support tests passed as listed above.

## Deferred work

Phase 6 automated cleanup and required gates are complete. Manual smoke remains for Phase 7/review before promoting to `origin/custom-acp`.
