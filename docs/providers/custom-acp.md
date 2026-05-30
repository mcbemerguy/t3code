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

When the ACP server advertises Pi workflow capabilities, T3Code Custom ACP tracks active workflow run ids and the last observed workflow event sequence in its resume cursor. On browser reload, server restart, or provider restart, the Custom ACP provider resumes the ACP session with `session/load` when required, lets the ACP server replay standard `session/update` presentation, and deduplicates replayed workflow events by sequence.

Supported Pi extension methods are additive and prefixed:

- `_pi/workflows/list`
- `_pi/workflows/get`
- `_pi/workflows/events`
- `_pi/workflows/resume`
- `_pi/workflows/pause`
- `_pi/workflows/abort`

T3Code uses these methods only when the ACP server advertises them. Standard ACP updates remain the rendering path, so generic ACP behavior is preserved. Active workflow notices include the run id and audit path when available. If dedicated workflow buttons are not present, T3Code surfaces textual actions; users can still validate/control recovery through the Pi-specific ACP methods.

Interrupt behavior is conservative: the first interrupt for an active Pi workflow requests `_pi/workflows/pause` instead of treating the workflow as terminally cancelled. Resume and abort are explicit actions. Ambiguous side-effecting child steps are expected to pause/interrupt instead of being automatically rerun. Pi workflow recovery is based on Pi artifacts and ACP replay, not on injecting workflow progress into model-visible transcript context.

Run `/home/marcosb/.pi/agent/extensions/workflows/scripts/recovery-smoke.md` before changing Custom ACP workflow recovery. It covers T3Code UI reload, T3Code server restart, `pi-acp` process restart, parent `pi --mode rpc` restart plus ACP `session/load`, detached child crashes before/after final handoff, user interrupt followed by resume, and user interrupt followed by explicit abort.
