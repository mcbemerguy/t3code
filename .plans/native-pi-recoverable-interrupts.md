# Native Pi recoverable interrupts and stalled-session recovery

## Objective

Make T3Code's native Pi provider recoverable after provider errors, user interrupts, wedged aborts, and silent/stalled Pi RPC sessions. The expected behavior is parity with the robust cancellation model from the `custom-acp` branch: T3 must complete/clear its own turn lifecycle locally and keep the UI usable even when the remote agent/provider fails to acknowledge cancellation.

## Primary invariants

- T3 lifecycle state must not depend on Pi RPC `abort`, `prompt`, or workflow control requests succeeding.
- User Stop/Interrupt must always make the current T3 turn locally terminal within a bounded time.
- After an interrupted/failed/stale turn, the next user message must start a new Pi `prompt`, not route to `steer` for a poisoned active turn.
- Preserve the latest Pi `resumeCursor`/`sessionFile` before discarding a wedged runtime; recovery must resume the durable Pi session, not create an unrelated conversation.
- Late Pi events from an already locally completed turn must be idempotent and must not reopen the thread/session lifecycle.
- Provider runtime events that transition lifecycle must carry the correct provider turn id so `ProviderRuntimeIngestion` strict lifecycle guards accept the intended transition.
- Workflow Stop semantics must not regress: explicit pause remains pause; user interruption should terminate/interrupt active work and leave a recoverable run/session state.
- Recovery UX must surface a durable error/warning/activity when T3 has locally interrupted or restarted Pi due to an unresponsive provider.

## Source references

Current native Pi path:

- `apps/server/src/provider/Layers/PiAdapter.ts`
  - `sendTurn`, active-turn `steer` routing, `interruptTurn`, `pauseActiveWorkflows`, `completeTurn`, workflow control handling.
- `apps/server/src/provider/Layers/PiSessionRuntime.ts`
  - Pi RPC `prompt`, `abort`, `workflowControl`, timeout usage, state/resume cursor extraction.
- `apps/server/src/provider/Layers/PiRpcProcess.ts`
  - pending request timeouts, process diagnostics, termination behavior.
- `apps/server/src/provider/Layers/PiEventMapper.ts`
  - Pi `prompt_end`/`agent_end` to `turn.completed`, runtime error mapping, late event handling.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  - strict lifecycle guard for `turn.completed`, `session.state.changed`, `runtime.error`, `session.exited`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  - `thread.turn.interrupt` dispatch into `ProviderService.interruptTurn`.
- `apps/server/src/provider/Layers/ProviderService.ts`
  - routed interrupt/send/session persistence boundaries.

Reference behavior from `custom-acp` branch:

- `custom-acp:apps/server/src/provider/Layers/GenericAcpAdapter.ts`
  - local turn state: `completedTurnIds`, `cancellingTurnIds`, `turnIdle`, `turnPromptCompletions`.
  - `completeTurnLocally(...)`, `releaseTurnReservation(...)`.
  - interrupt watchdog constants and bounded cancel drain.
  - `interruptTurn` marks cancellation locally, sends remote cancel best-effort, forces local completion/discards runtime if remote cancellation does not settle.

Existing tests/gaps:

- `apps/server/src/provider/Layers/PiAdapter.test.ts`
  - covers prompt failure, active-turn steer routing, basic interrupt, pending extension UI cancellation, workflow controls.
  - missing abort rejection/timeout recovery, no-event stall recovery, and post-interrupt next-message-as-new-prompt coverage.
- `apps/server/src/provider/Layers/PiSessionRuntime.test.ts`
  - covers request timeouts and process-exit diagnostics.
  - missing prompt preflight timeout and abort timeout/failure behavior at adapter level.
- Provider-service restart/resume coverage exists, but native Pi adapter recovery should have direct tests around local runtime discard/restart decisions.

## Phase 1 — Lock down failure modes with tests

Goal: create failing coverage that captures the unrecoverable T3 freeze without changing behavior broadly.

Test the native Pi adapter as the main boundary. Cover at least:

- Stop/interrupt while a Pi turn is active and `runtime.abort()` rejects or times out.
- Stop/interrupt while Pi has emitted partial output but never emits `prompt_end`/`agent_end`.
- A user message sent after local interrupt starts a new Pi prompt instead of steering into the stale turn.
- Pending extension UI requests are resolved/cancelled even when abort fails.
- Late Pi `prompt_end`/`agent_end` after local completion does not emit duplicate or lifecycle-conflicting completion.
- Provider runtime ingestion accepts the local completion and clears active turn state under strict lifecycle guard.

Keep tests focused on observable provider/runtime events and session state. Do not rely on exact implementation internals beyond fake runtime hooks already present in `PiAdapter.test.ts`.

## Phase 2 — Add native Pi local turn lifecycle and bounded interrupt

Goal: port the `custom-acp` cancellation model conceptually into native Pi.

Implement native Pi-local turn state sufficient to distinguish:

- active turn;
- cancelling turn;
- completed turn;
- stale/recovering runtime.

Change native Pi interrupt behavior so user interruption:

- immediately cancels pending Pi extension UI/user input requests;
- marks the relevant turn as cancelling;
- emits a locally terminal `turn.completed`/abort lifecycle transition within a bounded time;
- never leaves `turnCompleted = false` solely because Pi RPC abort failed;
- keeps late Pi lifecycle events idempotent.

Remote `abort()` should become best-effort cleanup, not the gate for T3 becoming usable again.

After this phase, the exact user-reported scenario should recover without requiring a full runtime restart if the only issue is failed/late abort acknowledgement.

## Phase 3 — Runtime discard/restart for poisoned Pi RPC sessions

Goal: recover when the Pi RPC subprocess or upstream provider is wedged beyond local turn completion.

Define a native Pi recovery path that:

- captures the latest known resume cursor/session file before closing the runtime;
- closes/kills the Pi RPC process if cancellation/abort does not settle in the watchdog window;
- restarts Pi RPC with the preserved cursor/session file when the thread needs continued use;
- refreshes Pi state after restart and updates persisted session metadata;
- emits a visible runtime warning/error/activity explaining that T3 recovered by restarting Pi RPC.

Do not create a new unrelated Pi conversation as a recovery fallback. If no resume cursor/session file is available, fail visibly and require explicit user action rather than silently continuing in a different session.

## Phase 4 — Stalled prompt and no-event watchdogs

Goal: prevent silent indefinite running states during provider outages.

Add bounded handling for two different stalls:

- Pi RPC prompt acknowledgement never arrives.
- Prompt starts but no Pi events arrive for a configurable duration while T3 still considers the turn running.

The prompt acknowledgement timeout is safe because Pi RPC prompt response is only turn acceptance/preflight, not the full model completion. No-event stall handling should first surface a warning and preserve Stop/Recover controls; hard recovery should only occur after a longer threshold or explicit user interrupt.

Keep timeout values configurable or centrally defined with clear defaults. Avoid per-call inline timeout constants scattered across adapter code.

## Phase 5 — Workflow interruption parity

Goal: make workflow-related interruptions compatible with the general recovery model without reintroducing frozen sessions.

Align workflow behavior with these semantics:

- User Stop means interrupt/cancel active work, not passive pause.
- Explicit workflow pause remains available only through explicit pause controls/commands.
- Workflow interrupt must also locally terminate the current T3 turn lifecycle within bounded time.
- Workflow artifact replay remains authoritative for final run state; T3 must not infer workflow success/failure from transient UI state.
- Restored/replayed workflow runs should remain discoverable after runtime restart and after later thread turns.

This phase can build on the general local completion/restart foundation rather than creating a separate workflow-only recovery mechanism.

## Phase 6 — UI and durable diagnostics

Goal: make recovery visible and understandable to the user.

Ensure the web UI receives durable thread activity for:

- local cancellation after unresponsive Pi abort;
- Pi RPC restart from resume cursor;
- unrecoverable missing-resume-cursor cases;
- stale/no-event warnings.

Avoid latest-turn-only presentation causing important recovery/workflow notices to disappear immediately after the next user message. If a recovery event changes session usability, it must remain inspectable in thread history or session diagnostics.

## Phase 7 — Validation and regression pass

Run the native Pi-relevant validation after implementation:

- targeted Pi adapter/session runtime tests;
- provider service/runtime ingestion tests touched by lifecycle changes;
- T3Code required checks from `AGENTS.md`: `vp check` and `vp run typecheck`.

Manual smoke scenarios before completion:

- start a Pi turn, interrupt, then send `continue`; verify a new prompt starts and UI updates;
- simulate/force abort failure and verify T3 still returns to usable state;
- resume the same Pi session after runtime restart and verify prior context is preserved;
- interrupt an active workflow and verify both T3 UI and workflow artifacts reach recoverable terminal/non-running state;
- verify late Pi `prompt_end` from a stale runtime does not corrupt the current active turn.
