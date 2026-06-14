# Pi workflow controls promotion notes

Branch: `port/pi-workflow-controls-phase1`
Source branch: `origin/merge/upstream-mobile-wip-custom-acp` at `fdcdae5dce38b7bfb8722b0f36686c52fb27f102`
Base branch: `merge/upstream-main-20260613` at `41bd4548cb3de01dfb0f4f15b4313a703b70e861`

## Merge strategy

This branch selectively ports the final Pi workflow-control behavior from the stale source branch instead of merging that branch wholesale. The source branch contains older mobile/upstream/provider/UI work that would regress current T3Code if merged directly.

The port preserves current Custom ACP, Grok/xAI provider support, current timeline/sidebar/composer structure, and current migration ordering. Pi workflow controls stay private/additive Custom ACP extension behavior under `_pi/workflows/*` and are used only when advertised by the ACP server.

## Ported behavior

Implementation commits on this branch:

- `0055ab7e` — Port workflow control command path.
- `36d8eaa3` — Allow workflow controls to recover stopped sessions.
- `8f905aec` — Port Pi workflow ACP controls.
- `51840fb5` — Fix Pi workflow ACP review issues.
- `b508200d` — Persist workflow cursors in thread projections.
- `345d7c1d` — Restore Pi workflow sidebar controls.
- `dcc12be6` — Fix workflow sidebar stop control dispatch.

Source-branch behavior used as reference includes workflow cursor persistence, replay cursor rewind prevention, state refresh after Stop, final Tasks sidebar controls, `/workflow-abort`, active workflow session preservation, and throttle/reaper hardening.

## Migration

The projection migration is `037_ProjectionThreadSessionWorkflowRuns`. The stale source branch migration id `034_ProjectionThreadSessionWorkflowRuns` was intentionally not reused because current main already has migrations `034_ProjectionCustomAcpCompatibility`, `035_AuthAuthorizationScopes`, and `036_AuthPairingProofKeyThumbprint`.

## Intentionally unported source areas

The following source-branch areas are intentionally out of scope for this workflow-control restoration:

- Mobile WIP aggregate changes from the stale branch.
- Thread delete/destructive provider lifecycle work, including Custom ACP session delete/close cleanup, `_pi/session/delete`, delete tombstoning, multi-delete handling, and stuck delete regressions. This port does not mix thread delete lifecycle changes unless a future workflow-control dependency is proven.
- Source-branch delete lifecycle documentation.
- Local tooling/package/workspace churn such as the stale branch's pnpm/Vite+ switch.
- Unrelated ACP notification/reasoning-stream detail changes that are not required for workflow controls.
- Composer-banner workflow UI; only the final Tasks sidebar control surface was ported.

## Validation status

Automated validation completed before these documentation notes:

- Server workflow/control/provider focused tests passed.
- Web workflow control and `/workflow-abort` tests passed from `apps/web`.
- `vp check` passed with 0 errors and 11 existing warnings.
- `vp run typecheck` passed.

Phase 7 documentation validation:

- `vp fmt --check docs/providers/custom-acp.md docs/project/pi-workflow-controls-promotion-notes.md` passed.
- `vp check` passed with 0 errors and 11 existing warnings.
- `vp run typecheck` passed with an existing `effect(unnecessaryTypeofType)` suggestion in `apps/server/src/provider/acp/CursorAcpExtension.ts`.

Manual live Custom ACP/Pi smoke has not been performed and is still required before promotion. Required smoke includes launching a Pi workflow from `agent/extensions/workflows`, verifying Tasks sidebar controls, Stop recovery, Resume/Continue, Abort, browser reload, T3Code server restart, and `pi-acp` restart without duplicate presentation or cursor rewind.
