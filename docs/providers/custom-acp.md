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

## Provider lifecycle: Stop/Close vs Delete

Custom ACP treats normal Stop/Close and thread Delete as separate lifecycle intents:

- Stop and provider shutdown are non-destructive. T3Code cancels active work, settles pending approvals/user-input, and calls ACP `session/close` when the server advertises it. Backing ACP history remains resumable/importable.
- Thread Delete is destructive only when the provider supports it. Before the local thread binding is lost, T3Code requests provider cleanup with `deleteBackingSession: true`; Custom ACP then calls ACP `session/delete` if advertised. If delete is unsupported or fails, local runtime cleanup still happens and T3Code records a warning/toast that backing history may still exist.
- Archive and ordinary Stop must not request backing-session deletion.

For `pi-acp`, Delete means the adapter closes the live Pi subprocess first, validates the mapped Pi JSONL session file, unlinks only that validated file, removes its session-map entry, and marks recoverable workflow runs for the deleted parent aborted. It does not remove project files, workflow audit directories, child session artifacts, or global Pi configuration.

Smoke checks after lifecycle changes:

1. Idle Pi-backed thread Delete: session disappears from Custom ACP import/list and the Pi JSONL is gone.
2. Active-turn Delete: the browser thread is removed, T3Code shows a warning only on cleanup failure, and no `pi --mode rpc` process remains.
3. Stale/wrong mapping: delete is safe and does not unlink a wrong-session/wrong-cwd Pi JSONL.
4. Unsupported delete: a Custom ACP server without `session/delete` gets close-only cleanup and a visible/durable warning.
5. Windows/stuck cancel: killing through `pi.cmd`/shell escalates to the full process tree; a Pi turn that ignores abort still leaves no child process.

Diagnostics to check: T3Code server logs include `custom ACP session lifecycle requested`; provider runtime warnings/audit events record ACP close/delete timeout or failure; `pi-acp` stderr logs delete request parameters, resolved session file, validation refusal, unlink result, and kill escalation.

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

T3Code uses these methods only when the ACP server advertises them. Standard ACP updates remain the rendering path, so generic ACP behavior is preserved. Active workflow notices include the run id and audit path when available, and recoverable Pi workflow runs are exposed through provider workflow controls for Continue/Resume, Interrupt/Pause when supported, and explicit Abort.

The normal Stop button remains an interrupt for the current execution. During an active Pi workflow turn, T3Code sends standard ACP `session/cancel`; `pi-acp` forwards that to Pi so the detached child is stopped and the run remains recoverable instead of terminally cancelled. Pause is a separate cooperative control and must not be treated as proof that a live child process stopped. A normal next user message continues the single recoverable Pi workflow for the thread; when multiple runs are recoverable, T3Code requires an explicit workflow control choice. `_pi/workflows/resume`/Continue routes to Pi's workflow resume execution path, where handoff reconciliation and redo decisions happen. Abort is explicit and terminal. Ambiguous side-effecting child steps are expected to pause/interrupt instead of being automatically rerun. Pi workflow recovery is based on Pi artifacts and ACP replay, not on injecting workflow progress into model-visible transcript context.

Run `../../agent/extensions/workflows/scripts/recovery-smoke.md` before changing Custom ACP workflow recovery. It covers T3Code UI reload, T3Code server restart, `pi-acp` process restart, parent `pi --mode rpc` restart plus ACP `session/load`, detached child crashes before/after final handoff, Stop followed by resume/continue, and Stop followed by explicit abort.
