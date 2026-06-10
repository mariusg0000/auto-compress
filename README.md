# auto-compress — OpenCode Context Compaction and Segment Summaries

`auto-compress` is an OpenCode plugin that automatically prunes old context when token usage grows, summarizes what was pruned into per-segment files, and injects a structured synthetic summary bundle back into the active context.

## For Humans

### What It Does

- Watches context size on every request build.
- When context is too large, prunes older messages.
- Summarizes the pruned segment in a temporary session.
- Stores per-session summary chunks and prepends a retained summary bundle to future requests.

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
    "maxContextTokens": 100000,
    "minContextTokens": 60000,
    "summaryMaxTokens": 1000,
    "maxSummaryFiles": 10,
    "tokenCoefficient": 4,
    "model": "opencode-go/mimo-v2.5",
    "stripReasoning": {
      "enable": true,
      "preserveLast": 5
    },
    "logLevel": "debug"
  }
]
```

If you enable integrated `stripReasoning`, remove the separate `strip-reasoning` plugin from the same OpenCode config.

### Configuration

| Option                           | Type    | Default | Practical Effect                                                                    |
| -------------------------------- | ------- | -------:| ----------------------------------------------------------------------------------- |
| `maxContextTokens`               | number  | `100000` | Compaction starts when estimated active provider-visible payload reaches this limit |
| `minContextTokens`               | number  | `60000` | Target estimated token budget kept after compaction                                |
| `summaryMaxTokens`               | number  | `1000`  | Approximate summary budget requested from summarizer                                |
| `maxSummaryFiles`                | number  | `10`    | Number of per-session summary chunks retained and injected back as historical context |
| `tokenCoefficient`               | number  | `4`     | Character-to-token divisor used by the static estimator                             |
| `model`                          | string  | `opencode-go/mimo-v2.5` | Fixed summarizer model in `provider/model` format                  |
| `failureBackoffStepTokens`       | number  | `5000`  | Raises compaction trigger after each summary failure                                |
| `failureBackoffMaxOffsetTokens`  | number  | `25000` | Caps the failure backoff offset applied to max/min token thresholds                 |
| `stripReasoning.enable`          | boolean | `true`  | Strips reasoning parts from the final request payload and from summary transcripts   |
| `stripReasoning.preserveLast`    | number  | `5`     | Keeps the newest N reasoning parts in the payload and summary transcript             |
| `logLevel`                       | string  | `debug` | `none` = silent, `error` = critical errors only, `debug` = file debug logs           |
| `debugTokenCalc`                 | boolean | `false` | Writes detailed token estimator traces when `logLevel: debug`                        |

Reasoning settings:

- `stripReasoning.preserveLast` counts reasoning parts globally across the assembled payload, not per message.
- `stripReasoning.enable: true` keeps provider token thresholds unchanged; it only affects local cut-point estimation, summary transcript reasoning inclusion, and the final returned payload.

### Recommended Settings

- Cost-focused: `30000 / 15000 / 3000`
- Balanced: `40000 / 20000 / 6000`
- Fidelity-focused: `70000 / 30000 / 8000`

Numbers above are `maxContextTokens / minContextTokens / summaryMaxTokens`.

### Effect On Coding Workflow

Pros:

- Greatly reduces context overflow during long sessions.
- Preserves continuity via structured summary instead of hard reset.
- Reduces pressure on manual context management.

Cons:

- Raw, line-by-line historical details are replaced by retained summary chunks.
- Summary quality depends on model quality and prompt signal.
- Compaction behavior adds complexity compared to stateless chat.

### Troubleshooting

- If summaries look weak, verify active model quality and tune `summaryMaxTokens`.
- If compaction feels too aggressive, raise `maxContextTokens` and/or `minContextTokens`.
- If you want no disk debug artifacts, keep `logLevel: none`.

## For LLM

### Technical Contract

- Hook: `experimental.chat.messages.transform`.
- Input: request-time assembled message list (`output.messages`).
- Output: rebuilt list with optional synthetic summary + pruned active tail.
- This plugin modifies request payload state, not historical chat DB records.

### OpenCode Hook Position

- Runs in plugin order from `opencode.json`.
- Integrated reasoning stripping is available via `stripReasoning` options.
- Do not run the separate `strip-reasoning` plugin together with this integrated mode.

### Runtime Flow

1. Load state from `~/.config/opencode/logs/auto-compress/state/<sessionID>.json`.
2. Reconstruct message list by removing already summarized IDs and old synthetic summary marker.
3. Read the latest provider-reported prompt context tokens from the newest assistant usage record.
4. If provider-reported context is below `maxContextTokens`, return reconstructed messages after optional reasoning strip.
5. If provider-reported context reaches threshold, compute prune cut with the local estimator so only about `minContextTokens` of newest retained content remains.
6. Extend cut when needed to avoid splitting tool-use/result semantics.
8. Build transcript from pruned messages:
    - include text parts,
    - include only the newest configured reasoning parts as `[REASONING]` blocks,
    - include compact tool title/output/error text,
    - remove `<system-reminder>...</system-reminder>` blocks,
    - skip empty lines/messages.
9. Load the retained per-session summary chunks for historical continuity.
10. Summarize the newly pruned segment using temporary session and `promptAsync` with `agent: "compaction"`.
11. Save the new summary as `summaries/<sessionID>/<sequence>.md`, then trim older chunks beyond `maxSummaryFiles`.
12. Save updated `summarizedIDs` in state.
13. Return final message list with one synthetic summary bundle prepended.

### State And Files

| Path                                                                       | Role                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `~/.config/opencode/logs/auto-compress/state/<sessionID>.json`             | Persistent functional state (`summarizedIDs`, failure state, legacy migration slot) |
| `~/.config/opencode/logs/auto-compress/summaries/<sessionID>/<NNNNNN>.md`  | Retained per-session summary chunks in chronological order |
| `~/.config/opencode/logs/auto-compress/auto-compress.log`                  | Debug log when `logLevel: debug`                         |
| `~/.config/opencode/logs/auto-compress/prune-<sessionID>-<timestamp>.json` | Per-prune debug snapshots when `logLevel: debug`         |

Retention policy:

- On plugin startup, delete `state/*` and `summaries/*` older than 30 days.

### Invariants

- `state/*.json` is functional state, not disposable debug data.
- `summaries/<sessionID>/*.md` is functional retained context, not disposable debug data.
- `logLevel: none` must produce no file logging/debug snapshots.
- Summarization uses the active session model.
- Transcript must strip `<system-reminder>` blocks before summarization.
- Provider-reported context tokens remain the only trigger for compaction thresholds and hard caps.
- When `stripReasoning.enable: true`, reasoning strip is applied only at final payload return and inside summary transcript construction.

### Edge Cases

- If summarization fails below the hard token cap, plugin skips prune and increases the failure backoff.
- If summarization fails above the hard token cap, plugin still prunes and surfaces runtime failure via UI error path.
- Status polling includes fallback message checks when idle state is not returned promptly.
- Temporary summarization session cleanup is attempted in `finally`.

### Safe Change Guidelines

- Do not remove tool boundary safety logic around prune cut extension.
- Do not downgrade state write behavior to debug-only; it breaks continuity.
- Keep transcript sanitizer deterministic and side-effect free.
- Keep summary banner format stable unless downstream consumers are updated.

### Do Not Change Without Review

- `summarizedIDs` semantics in session state files.
- Hook name and transform output shape.
- Failure mode that allows compaction to continue on summarization errors.
- `debug` master switch semantics.

## Version

Last modified: 2026-05-24
