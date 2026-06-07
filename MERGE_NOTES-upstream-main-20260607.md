# Upstream main merge notes — 2026-06-07

Integration branch: `merge/upstream-main-20260607`
Base branch: `custom-acp` at `0adbb9eb`
Upstream target: `upstream/main` at `3ea6adf1`
Merge command: `git merge --no-ff upstream/main`

## Phase 1 mechanical resolutions applied

- `.gitignore`: combined local Pi launch stamp ignores with upstream `.alchemy/`, `node_modules/`, `*.log`, and `.env*` rules.
- `apps/web/src/rpc/transportError.ts`: accepted upstream web re-export for the client-runtime move.
- `apps/web/src/rpc/wsTransport.ts`: accepted upstream web wrapper around `@t3tools/client-runtime` transport.
- `apps/web/src/rpc/wsTransport.test.ts`: accepted upstream web instrumentation tests after transport ownership moved to `packages/client-runtime`.
- `apps/web/src/environments/runtime/service.ts`: resolved the import-only conflict by keeping upstream `terminalUiStateStore` naming and the custom thread read-state seed import required by already-merged call sites.

No vendored `.repos/` files were hand-edited; `.repos/` changes present in the worktree are from the upstream merge.

## Phase 2 persistence/contracts/RPC resolutions applied

- `packages/contracts/src/index.ts` and `packages/contracts/src/ipc.ts`: exported and typed both custom ACP external session import contracts and upstream review/runtime contracts.
- `packages/client-runtime/src/wsRpcClient.ts`: exposed both `customAcp` and upstream `review` client surfaces; preserved custom orchestration subscription retry behavior through `retryNonTransportErrors` in `packages/client-runtime/src/wsTransport.ts`.
- `apps/web/src/environmentApi.ts` and `apps/web/src/localApi.test.ts`: mapped/tested both custom ACP and review API surfaces.
- `apps/server/src/ws.ts`: added auth scope mapping for `customAcp.listSessions` (`orchestration:read`) and `customAcp.importSession` (`orchestration:operate`) alongside upstream auth/review/terminal/cloud/relay scopes.
- `apps/server/src/persistence/Migrations.ts`: kept published custom ACP migration records 31-33 intact, added 34 as an idempotent projection compatibility migration, and renumbered upstream auth scope/proof-key migrations to 35-36.
- Migration compatibility details: Effect SQL migrations only compare pending migrations by IDs greater than the latest recorded `effect_sql_migrations.migration_id`. Therefore upstream auth migrations cannot remain at IDs 31-32 without being skipped on DBs already migrated through current custom ACP ID 33. `035_AuthAuthorizationScopes` is compatibility-safe: it migrates role-based auth rows in place into scoped auth tables (`owner` → administrative scopes, `client` → standard client scopes), preserves already-scoped rows, and removes legacy `role` columns without invalidating existing auth rows.

Validation run for Phase 2:

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm exec vp test run apps/server/src/persistence/Migrations/034_036_MergeCompatibility.test.ts apps/server/src/persistence/Migrations/035_AuthAuthorizationScopes.test.ts packages/client-runtime/src/wsRpcClient.test.ts packages/client-runtime/src/wsTransport.test.ts`
- `pnpm exec vp run --filter @t3tools/contracts typecheck`
- `pnpm exec vp run --filter @t3tools/client-runtime typecheck`
- `pnpm exec vp test run packages/contracts/src/server.test.ts packages/contracts/src/settings.test.ts packages/contracts/src/relay.test.ts packages/contracts/src/terminal.test.ts`

Double-check/fix validation:

- `pnpm exec vp test run apps/server/src/persistence/Migrations/035_AuthAuthorizationScopes.test.ts apps/server/src/persistence/Migrations/034_036_MergeCompatibility.test.ts packages/contracts/src/server.test.ts packages/contracts/src/settings.test.ts packages/contracts/src/relay.test.ts packages/contracts/src/terminal.test.ts`
- `pnpm exec vp run --filter @t3tools/contracts typecheck`
- `pnpm exec vp test run packages/client-runtime/src/wsRpcClient.test.ts packages/client-runtime/src/wsTransport.test.ts packages/contracts/src/server.test.ts packages/contracts/src/settings.test.ts packages/contracts/src/relay.test.ts packages/contracts/src/terminal.test.ts`
- `pnpm exec vp run --filter t3 typecheck` still fails only on unresolved later-phase conflict markers in `apps/server/scripts/acp-mock-agent.ts` and `apps/server/src/provider/acp/CursorAcpExtension.ts`.

## Phase 3 client-runtime/environment resolutions applied

- `apps/web/src/environments/runtime/connection.ts`: accepted upstream runtime-package ownership and kept the web file as a thin `@t3tools/client-runtime` re-export.
- `packages/client-runtime/src/environmentConnection.ts`: ported the custom post-reconnect recovery hook into the shared runtime seam as `onRecovered`, while keeping upstream bootstrap disposal behavior, lifecycle/config identity checks, optional terminal event wiring, and attempt registry exports.
- Reconnect/resubscribe behavior: shell subscriptions now reset the bootstrap gate on active stream resubscribe, wait for a fresh shell snapshot, then run `onRecovered` serially. Manual reconnect waits for a shell snapshot that arrives after the reconnect-triggered resubscribe generation, so stale snapshots from the pre-reconnect stream cannot release recovery early. This preserves custom read-state/thread-detail refresh after reconnect without firing before the live view has a fresh snapshot.
- Existing runtime client surfaces remain merged: custom ACP `listSessions`/`importSession`, upstream terminal attach/metadata streams, review diff preview, cloud/relay APIs, and moved WebSocket transport/client primitives.

Validation run for Phase 3:

- `pnpm exec vp test run packages/client-runtime/src/wsTransport.test.ts apps/web/src/environments/runtime/connection.test.ts`
- `pnpm exec vp run --filter @t3tools/client-runtime typecheck`
- `pnpm exec vp test run packages/client-runtime/src/wsRpcClient.test.ts packages/client-runtime/src/wsTransport.test.ts apps/web/src/environments/runtime/connection.test.ts apps/web/src/localApi.test.ts`

Double-check/fix validation:

- `pnpm exec vp test run apps/web/src/environments/runtime/connection.test.ts packages/client-runtime/src/wsTransport.test.ts`
- `pnpm exec vp run --filter @t3tools/client-runtime typecheck`

Full `vp check` / web typecheck remain deferred until the later-phase server ACP and timeline conflict markers are resolved.

## Phase 4 server ACP provider/mock-agent resolutions applied

- `apps/server/src/provider/acp/CursorAcpExtension.ts`: kept the shared generic ask-question schema/normalizer so Cursor and Custom ACP use one compatible path, preserved Cursor's `OK` fallback for optionless prompts, and added upstream Cursor `cursor/list_available_models` response decoding with per-model config options.
- `apps/server/scripts/acp-mock-agent.ts`: kept upstream Node-based mock execution and Cursor parameterized model discovery support while preserving custom ACP/Pi knobs for session list/load failure, workflow capability metadata, replay events, steering, pause/resume/abort, cancellation, available commands, and custom regression scenarios.
- `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`: aligned remaining mock-agent spawns with the Node mock command used by the upstream script migration.
- `apps/server/src/provider/acp/AcpRuntimeModel.test.ts`: updated the typed execute-tool expectation for the merged runtime model's official command-execution item type projection.

Validation run for Phase 4:

- `pnpm exec vp test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/CursorAcpExtension.test.ts apps/server/src/provider/acp/AskQuestionExtension.test.ts apps/server/src/provider/acp/PiWorkflowExtension.test.ts apps/server/src/provider/acp/CustomAcpSessionImport.test.ts apps/server/src/provider/acp/AcpUsage.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/CursorAcpSupport.test.ts apps/server/src/provider/acp/CustomAcpSupport.test.ts apps/server/src/provider/Layers/CustomAcpProvider.test.ts apps/server/src/provider/Layers/CursorProvider.test.ts`
- `pnpm exec vp run --filter t3 typecheck`

Double-check/fix validation:

- `pnpm exec vp test run apps/server/src/provider/acp/AskQuestionExtension.test.ts apps/server/src/provider/acp/CursorAcpExtension.test.ts apps/server/src/provider/acp/CustomAcpSessionImport.test.ts apps/server/src/provider/Layers/CustomAcpProvider.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `pnpm exec vp run --filter t3 typecheck`

Full `vp check` / full workspace typecheck remain deferred until the Phase 5 web timeline conflict markers are resolved.

## Phase 5 web timeline/session UX resolutions applied

- `apps/web/src/components/ChatView.browser.tsx`: merged the browser test environment API mock so it exposes both custom ACP session import methods and upstream review APIs.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: kept upstream changed-file/review rendering imports and custom ACP/Pi work-log rendering imports together. The resulting component preserves structured review comment cards, changed-file diff sections, compact ACP tool rows, Pi thought/tool labels, file path links, and undelivered-message retry UI.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`: switched to upstream `vite-plus/test` imports while retaining `TurnId` coverage, then added row-order/metadata regression coverage for upstream changed-file/review entries and custom ACP/Pi thought/tool rows.
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`: added static render coverage for Pi thought rows and compact ACP file tool rows without duplicate labels.
- `apps/web/src/environments/runtime/service.threadSubscriptions.test.ts`: updated the merged `WsRpcClient` mock to include the custom ACP surface required by the combined client runtime type, and wired `createWsRpcClient` through the test-controlled mock so reconnect heartbeat freshness assertions exercise the intended client setup.

Validation run for Phase 5:

- `pnpm exec vp run --filter @t3tools/web test -- apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/environments/runtime/service.threadSubscriptions.test.ts` (passes; Vite+ unit project ran 102 files / 1065 tests)
- `pnpm exec vp run --filter @t3tools/web typecheck` (passes)
- `pnpm exec vp run --filter @t3tools/web test:browser -- apps/web/src/components/ChatView.browser.tsx` could not start because Playwright's Chromium executable is not installed in this checkout (`pnpm exec playwright install` required).

Double-check/fix validation:

- `pnpm exec vp run --filter @t3tools/web test -- apps/web/src/environments/runtime/service.threadSubscriptions.test.ts` (passes; Vite+ unit project ran 102 files / 1065 tests)
- `pnpm exec vp run --filter @t3tools/web typecheck` (passes)

## Remaining unresolved conflicts by domain

None known after Phase 5. Full `vp check` / full workspace typecheck remain Phase 6 cleanup gates.

## Phase 6 final validation and cleanup

Cleanup applied:

- Ran formatter via `pnpm exec vp check --fix` after the first Phase 6 `vp check` found formatting drift in two already-resolved test files.
- Removed stale references in `apps/web/src/environments/runtime/service.savedEnvironments.test.ts` to pre-move terminal state module names after confirming no live imports remained for `~/rpc/wsRpcClient`, `~/rpc/protocol`, `~/terminalActivity`, `~/terminalStateStore`, or `~/lib/terminalStateCleanup` outside obsolete test mocks.
- Cleaned lint warnings in `packages/client-runtime/src/environmentConnection.ts` without changing the reconnect/read-state recovery semantics.
- Rechecked conflict markers with `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- ':!*.lock' ':!.repos/**'`; none found outside vendored/lock exclusions.
- Confirmed `git diff --check` passes and no unmerged paths remain.

Validation run for Phase 6:

- `pnpm exec vp test run apps/server/src/persistence/Migrations/034_036_MergeCompatibility.test.ts apps/server/src/persistence/Migrations/035_AuthAuthorizationScopes.test.ts packages/contracts/src/server.test.ts packages/contracts/src/settings.test.ts packages/contracts/src/relay.test.ts packages/contracts/src/terminal.test.ts packages/client-runtime/src/wsRpcClient.test.ts packages/client-runtime/src/wsTransport.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/CursorAcpExtension.test.ts apps/server/src/provider/acp/AskQuestionExtension.test.ts apps/server/src/provider/acp/PiWorkflowExtension.test.ts apps/server/src/provider/acp/CustomAcpSessionImport.test.ts apps/server/src/provider/acp/AcpUsage.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/CursorAcpSupport.test.ts apps/server/src/provider/acp/CustomAcpSupport.test.ts apps/server/src/provider/Layers/CustomAcpProvider.test.ts apps/server/src/provider/Layers/CursorProvider.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` (passes; 20 files / 218 tests)
- `pnpm exec vp run --filter @t3tools/web test -- apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/environments/runtime/service.threadSubscriptions.test.ts apps/web/src/environments/runtime/connection.test.ts apps/web/src/localApi.test.ts apps/web/src/session-logic.test.ts` (passes; unit project ran 102 files / 1065 tests)
- `pnpm exec vp run --filter @t3tools/client-runtime test -- packages/client-runtime/src/wsRpcClient.test.ts packages/client-runtime/src/wsTransport.test.ts packages/client-runtime/src/environmentRuntimeState.test.ts packages/client-runtime/src/threadDetailState.test.ts` (passes; client-runtime project ran 24 files / 177 tests)
- `pnpm exec vp run --filter @t3tools/client-runtime test -- packages/client-runtime/src/environmentConnection.test.ts packages/client-runtime/src/wsTransport.test.ts` (passes after lint cleanup; client-runtime project ran 24 files / 177 tests)
- `pnpm exec vp run --filter @t3tools/web test -- apps/web/src/environments/runtime/service.savedEnvironments.test.ts` (passes after stale mock cleanup; unit project ran 102 files / 1065 tests)
- `pnpm exec vp check` (passes; all files formatted, no lint warnings/errors)
- `pnpm exec vp run typecheck` (passes across all 15 workspace packages/apps)

Intentional deviations / merge decisions to review:

- Migration numbering remains intentionally custom-compatible: published custom ACP migrations 31-33 are preserved, compatibility migration 34 is idempotent, and upstream auth migrations are applied as 35-36 so existing custom ACP databases that have reached migration 33 do not skip auth scope/proof-key setup.
- Custom ACP RPC methods are intentionally auth-gated: `customAcp.listSessions` requires `orchestration:read`, and `customAcp.importSession` requires `orchestration:operate`.
- Upstream pnpm/Vite+ workspace files remain authoritative; legacy Bun/Turbo root workflows were not restored.

Remaining manual smoke-test recommendations before pushing to `origin/custom-acp`:

- Install Playwright Chromium with `pnpm exec playwright install chromium` or `pnpm exec vp run --filter @t3tools/web test:browser:install`, then run `pnpm exec vp run --filter @t3tools/web test:browser -- apps/web/src/components/ChatView.browser.tsx`.
- Launch a local Custom ACP/Pi provider session and manually verify session import, pause/resume/replay steering, compact ACP/Pi timeline rows, and reconnect read-state recovery against a real browser session.
