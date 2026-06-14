# Pi workflow controls port inventory

Branch: `port/pi-workflow-controls-phase1`
Base: `merge/upstream-main-20260613` at `41bd4548cb3de01dfb0f4f15b4313a703b70e861`
Source branch: `origin/merge/upstream-mobile-wip-custom-acp` at `fdcdae5dce38b7bfb8722b0f36686c52fb27f102`
Merge base with source branch: `b06c580e7b3fe2377d383d22728818d189810549` (`base...source`: 91 base-only commits, 42 source-only commits)

## Source commits inventoried for selective port

- `d4ed7a1c6860` — Implement T3Code workflow controls
- `4bd44a1ca77c` — Fix T3Code workflow cursor persistence
- `6b4f17022fda` — Prevent stale workflow replay cursor rewinds
- `36d257c5eec7` — Harden Pi workflow state refresh after Stop
- `16b02f629879` — Finalize custom ACP workflow refresh cleanup
- `489ba85d90d1` — Remove composer workflow controls banner
- `b2bda83c9c7b` — Move Pi workflow controls into tasks sidebar
- `4014adbad37e` — Expose tasks sidebar for active workflows
- `a20b1d7b6629` — Add Pi workflow abort slash fallback
- `e1faa63d76fa` — Prioritize workflow abort slash command
- `009fcb0aa67d` — Preserve working state for running Pi workflows
- `9aef4e69a77d` — Backfill Pi workflow cursors in projection migration
- `ddd588ae2da4` — Preserve active ACP workflow sessions
- `fdcdae5dce38` — Persist workflow cursor changes through throttle

## File comparison summary before editing

All source paths from the plan were checked against current equivalents. Current equivalents exist except these source-only files:

- `apps/server/src/persistence/Migrations/034_ProjectionThreadSessionWorkflowRuns.ts`
- `apps/web/src/components/WorkflowRunControls.tsx`
- `apps/web/src/components/WorkflowRunControls.test.tsx`
- `apps/web/src/workflowSlashCommand.ts`

The targeted source-path diff is broad (`20 files changed, 2292 insertions, 677 deletions`) and must be ported selectively, not merged wholesale.

## Key current-code divergences to preserve

- Provider support: current has Grok provider support (`apps/server/src/provider/Drivers/GrokDriver.ts`, `apps/server/src/provider/acp/GrokAcpSupport.ts`, tests, settings/model entries) and xAI ACP ask-user-question support (`XAiAcpExtension.ts`, tests). The source branch lacks these files; any source diff that removes or bypasses them is stale.
- ACP runtime shape: current already has low-level `PiWorkflowExtension.ts` parsing/capability helpers but not the full contract/orchestration/UI path. Current ACP support includes newer Custom ACP, Grok, and xAI paths that must remain additive.
- Web UI/timeline: current `ChatView.tsx` uses newer `MessagesTimeline`, attachment-preview handoff, provider-delivery retry, auth/cloud UI, and current sidebar/composer signatures. Source `ChatView.tsx`/`ChatComposer.tsx` changes should be treated as behavioral reference only; do not replace current structures.
- Persistence/migrations: current migration sequence uses `034_ProjectionCustomAcpCompatibility`, `035_AuthAuthorizationScopes`, and `036_AuthPairingProofKeyThumbprint`. The source branch’s `034_ProjectionThreadSessionWorkflowRuns` id is stale; future work should add a new current migration, expected `037_...`.
- Projection/runtime schema: preserve current projection filters, runtime mode/provider instance fields, message provider-delivery metadata, activity ordering, archive indexes, and relay/environment contracts.
- Workspace/package layout: current package/workspace setup and scripts differ from the source branch. Source package/workspace churn is not part of this port.

## Stale-branch changes intentionally ignored in this phase

- No feature code was copied or edited in Phase 1.
- The aggregate source-branch diff was not merged.
- Source-branch deletions of current Grok/xAI provider support are ignored.
- Source migration number `034` is ignored in favor of a future current-sequence migration.
- Intermediate composer-banner workflow UI is ignored; only the final Tasks-sidebar behavior is a future reference.
- Broad thread delete/lifecycle or package/workspace changes are ignored unless a later phase proves a hard workflow-control dependency.

## Validation

- Confirmed starting branch `merge/upstream-main-20260613` was clean and at `41bd4548cb3de01dfb0f4f15b4313a703b70e861`.
- Created `port/pi-workflow-controls-phase1` from that base.
- Confirmed `origin/merge/upstream-mobile-wip-custom-acp` is available and resolves to `fdcdae5dce38b7bfb8722b0f36686c52fb27f102`.
- `vp check` completed with existing warnings and 0 errors.
- `vp run typecheck` completed successfully.
