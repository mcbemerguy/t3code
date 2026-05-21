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
