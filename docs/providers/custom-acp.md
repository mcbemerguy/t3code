# Custom ACP

T3Code can run an arbitrary Agent Client Protocol server through the Custom ACP provider.

## Blocking user questions

Custom ACP registers a Cursor-compatible blocking question extension by default:

- `askQuestionEnabled`: `true`
- `askQuestionMethod`: `cursor/ask_question`

The request shape is:

- `toolCallId?`: ACP agent request id for correlation
- `title?`: UI title
- `questions`: `{ id, prompt, options?, allowMultiple? }[]`

T3Code maps each request to a `user-input.requested` runtime event, waits for the browser answer, then returns `{ answers }` to the ACP server. Answers are keyed by the original question id. Single-select answers return the selected option label; custom text answers return the typed string. Questions without `options` are text-entry prompts; T3Code does not synthesize an `OK` option as an answer.

This is compatible with Pi through `pi-acp`: Pi `ask_user_questions` can run through three paths depending on host mode:

1. Pi in-process UI bridge handles the canonical interaction directly.
2. Local Pi TUI renders the questionnaire in the terminal.
3. Pi ACP/RPC sessions emit standard RPC dialogs; `pi-acp` translates them to `cursor/ask_question`, which T3Code handles here.

For a Pi smoke test, configure a Custom ACP provider to launch the local `pi-acp` build and explicitly expose the hidden Pi tool with `PI_DELEGATED_TOOL_CAP=ask_user_questions`. Keep the method as `cursor/ask_question` unless the ACP server requires another extension method.

## Pi workflow recovery

When the ACP server advertises Pi workflow capabilities, T3Code Custom ACP tracks active workflow run ids and the last observed workflow event sequence in its resume cursor. On browser reload, server restart, or provider restart, the Custom ACP provider resumes the ACP session with `session/load` when required, lets the ACP server replay standard `session/update` presentation, and deduplicates replayed workflow events by sequence. Current `pi-acp` `session/load` performs a full replay for attached recoverable runs; T3Code's saved `lastSequence` is what prevents duplicate plan/tool/message presentation.

Supported Pi extension methods are additive and prefixed:

- `_pi/workflows/list`
- `_pi/workflows/get`
- `_pi/workflows/events`
- `_pi/workflows/resume`
- `_pi/workflows/interrupt`
- `_pi/workflows/pause`
- `_pi/workflows/abort`

T3Code uses these methods only when the ACP server advertises them. Standard ACP updates remain the rendering path, so generic ACP behavior is preserved. Active workflow notices include the run id and audit path when available.

Active non-terminal Pi workflow runs are surfaced in the Tasks sidebar under **Pi workflows**. The sidebar shows workflow status, run id, audit/artifact paths when known, and per-run controls derived from the advertised Pi methods:

- **Continue** or **Resume** appears for interrupted, paused, or recovering runs and maps to `_pi/workflows/resume`.
- **Stop** appears for running runs and maps to `_pi/workflows/interrupt` when advertised, otherwise `_pi/workflows/pause`.
- **Abort workflow** appears in the per-run overflow menu and maps to `_pi/workflows/abort` after confirmation.

The composer footer keeps the Tasks toggle visible while active workflow runs exist, and the Tasks sidebar opens automatically for active workflow state. There is no composer-level workflow-control banner.

`/workflow-abort [run-id]` remains as a client-side fallback/shortcut for abort. It resolves the only abortable run when there is exactly one, requires an explicit run id when multiple abortable runs exist, and dispatches the same provider workflow-control abort action as the Tasks sidebar instead of sending raw text to the agent.

Stop and Abort are intentionally different. Stop is a recoverable interruption of current workflow execution: the Tasks sidebar Stop control targets a single run and sends the advertised non-terminal interrupt/pause action. The normal turn Stop button follows the provider-level turn-interruption path; for Custom ACP with active Pi workflows, that path first attempts the conservative workflow interrupt/pause action and only falls through to ACP turn cancellation when no active workflow can be controlled or the workflow-control path fails. A stopped workflow should remain recoverable through the workflow cursor and Pi artifacts. Abort is explicit, terminal, and destructive to future execution of that run: it marks the workflow aborted, keeps audit/artifact files, and removes the active workflow cursor after terminal replay is observed. Pause is cooperative and must not be treated as proof that a live child process has exited. Ambiguous side-effecting child steps are expected to pause/interrupt instead of being automatically rerun.

Pi workflow recovery is based on Pi artifacts (`run.json`, `events.jsonl`, child session artifacts, and `audit.md`) plus ACP `session/load`/workflow-event replay, not on injecting workflow progress into model-visible transcript context.

Run `/home/marcosb/.pi/agent/extensions/workflows/scripts/recovery-smoke.md` before changing Custom ACP workflow recovery. It covers T3Code UI reload, T3Code server restart, `pi-acp` process restart, parent `pi --mode rpc` restart plus ACP `session/load`, detached child crashes before/after final handoff, Stop followed by resume/continue, and Stop followed by explicit abort.
