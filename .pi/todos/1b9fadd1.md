{
  "id": "1b9fadd1",
  "title": "Expose underlying error when /answer immediately cancels",
  "tags": [
    "bug",
    "command",
    "extension",
    "diagnostics"
  ],
  "status": "open",
  "created_at": "2026-03-27T17:20:29.216Z"
}

The `/answer` command from the loaded answer Pi extension always immediately reports `Cancelled` and then returns to the prompt normally. It appears to go straight to `Cancelled` without showing the expected intermediate extraction loader (`Extracting questions using ...`).

Expected behavior: `/answer` should invoke the answer extension, extract questions from the last assistant message, present the interactive Q&A UI, and submit the user's answers. If extraction or UI setup fails, it should expose the underlying error instead of showing a generic `Cancelled` message.

## Investigation scope
- Inspect the answer extension implementation in `agent-stuff/extensions/answer.ts`.
- Investigate whether `ctx.ui.custom` or loader behavior in Pi core could be causing immediate cancellation before the loader renders.
- Determine why the current path results in `Cancelled` without surfacing the real failure.

## Suggested steps
- Reproduce by running `/answer` after an assistant message containing questions.
- Confirm whether the extraction loader renders or whether the command jumps directly to `Cancelled`.
- Add diagnostics or error propagation around the extraction flow; avoid swallowing errors with a generic cancellation result.
- Distinguish user-initiated cancellation from extraction/model/parsing/UI errors.
- Show a clear error notification when extraction fails, including the underlying error where safe.
- Verify that genuine user cancellation still reports cancellation appropriately.
- Verify that successful extraction still opens the interactive Q&A UI and submits answers correctly.
