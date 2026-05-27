# auto-compress — OpenCode Context Compaction and Rolling Summary

`auto-compress` is an OpenCode plugin that automatically prunes old context when token usage grows, summarizes what was pruned, and injects a structured synthetic summary back into the active context.

## For Humans

### What It Does

- Watches context size on every request build.
- When context is too large, prunes older messages.
- Summarizes the pruned segment in a temporary session.
- Stores a rolling summary per session and prepends it to future requests.

This keeps long coding sessions usable without constantly losing all prior context.

### When To Use It

Use it if you regularly hit context limits in long debugging, refactor, or implementation sessions.

Do not use it if you prefer fully raw transcript fidelity at all times and can tolerate manual resets.

### Installation

Add to `~/.config/opencode/opencode.json`:

```json
[
  "file:///home/marius/.opencode/auto-compress.js",
  {
    "maxContextMessages": 80,
    "minContextMessages": 50,
    "summaryMaxTokens": 6000,
    "model": "openai/gpt-5.4-mini",
    "debug": false,
    "debugRequestPayload": false
  }
]
```

### Configuration

| Option                | Type    | Default | Practical Effect                                                        |
| --------------------- | ------- | -------:| ----------------------------------------------------------------------- |
| `maxContextMessages`  | number  | `80`    | Compaction starts when active unsummarized messages reach this count    |
| `minContextMessages`  | number  | `50`    | Target number of newest active messages kept after compaction           |
| `summaryMaxTokens`    | number  | `1000`  | Approximate summary budget requested from summarizer                    |
| `model`               | string  | active session model | Fixed summarizer model in `provider/model` format             |
| `debug`               | boolean | `false` | Master file-debug switch; `false` disables log/debug file writes        |
| `debugRequestPayload` | boolean | `false` | Logs summarization HTTP payload JSON; effective only when `debug: true` |

### Recommended Settings

- Cost-focused: `30000 / 15000 / 3000`
- Balanced: `40000 / 20000 / 6000`
- Fidelity-focused: `70000 / 30000 / 8000`

Numbers above are `maxContextMessages / minContextMessages / summaryMaxTokens`.

### Effect On Coding Workflow

Pros:

- Greatly reduces context overflow during long sessions.
- Preserves continuity via structured summary instead of hard reset.
- Reduces pressure on manual context management.

Cons:

- Raw, line-by-line historical details are replaced by a summary.
- Summary quality depends on model quality and prompt signal.
- Compaction behavior adds complexity compared to stateless chat.

### Troubleshooting

- If summaries look weak, verify active model quality and tune `summaryMaxTokens`.
- If compaction feels too aggressive, raise `maxContextMessages` and/or `minContextMessages`.
- If you want no disk debug artifacts, keep `debug: false`.

## For LLM

### Technical Contract

- Hook: `experimental.chat.messages.transform`.
- Input: request-time assembled message list (`output.messages`).
- Output: rebuilt list with optional synthetic summary + pruned active tail.
- This plugin modifies request payload state, not historical chat DB records.

### OpenCode Hook Position

- Runs in plugin order from `opencode.json`.
- Reasoning stripping is handled by a separate plugin when desired.

### Runtime Flow

1. Load state from `~/.config/opencode/logs/auto-compress/state/<sessionID>.json`.
2. Reconstruct message list by removing already summarized IDs and old synthetic summary marker.
3. Count active unsummarized messages (excluding the synthetic summary message).
4. If active count is below `maxContextMessages`, return reconstructed messages.
5. If active count reaches threshold, compute prune cut so only `minContextMessages` newest active messages remain.
6. Extend cut when needed to avoid splitting tool-use/result semantics.
8. Build transcript from pruned messages:
   - include text parts only,
   - remove `<system-reminder>...</system-reminder>` blocks,
   - skip empty lines/messages.
9. Summarize using temporary session and `promptAsync` with `agent: "compaction"`.
10. Merge summary into rolling state and save updated `summarizedIDs`.
11. Return final message list with summary banner prepended.

### State And Files

| Path                                                                       | Role                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `~/.config/opencode/logs/auto-compress/state/<sessionID>.json`             | Persistent functional state (`summary`, `summarizedIDs`) |
| `~/.config/opencode/logs/auto-compress/auto-compress.log`                  | Debug log when `debug: true`                             |
| `~/.config/opencode/logs/auto-compress/prune-<sessionID>-<timestamp>.json` | Per-prune debug snapshots when `debug: true`             |

Retention policy:

- On plugin startup, delete `state/*` older than 30 days.

### Invariants

- `state/*.json` is functional state, not disposable debug data.
- `debug: false` must produce no file logging/debug snapshots.
- Summarization uses the active session model.
- Transcript must strip `<system-reminder>` blocks before summarization.

### Edge Cases

- If summarization fails, plugin continues compaction and surfaces runtime failure via UI error path.
- Status polling includes fallback message checks when idle state is not returned promptly.
- Temporary summarization session cleanup is attempted in `finally`.

### Safe Change Guidelines

- Do not remove tool boundary safety logic around prune cut extension.
- Do not downgrade state write behavior to debug-only; it breaks continuity.
- Keep transcript sanitizer deterministic and side-effect free.
- Keep summary banner format stable unless downstream consumers are updated.

### Do Not Change Without Review

- State schema (`summary`, `summarizedIDs`) in session state files.
- Hook name and transform output shape.
- Failure mode that allows compaction to continue on summarization errors.
- `debug` master switch semantics.

## Version

Last modified: 2026-05-24
