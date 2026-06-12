# Project Specs

========== USER SPECS ==========

========== AGENT GENERATED ==========

### Purpose
- OpenCode plugin for automatic context compaction.
- Prunes older context when token usage grows, summarizes pruned segments, and prepends retained summary chunks into later requests.
- Uses adaptive failure backoff when summarization fails.

### Active Scope
- Main hook is `experimental.chat.messages.transform` and it rewrites request-time `output.messages`.
- It does not mutate historical chat DB records.
- Already-summarized message IDs and synthetic summary messages are filtered out before rebuilding the request payload.
- Optional integrated `stripReasoning` behavior strips reasoning only on the returned payload and on summary-transcript inclusion, not on persisted history.
- Prune cut-point selection now keeps the estimator-selected boundary instead of rolling back generically to the chosen message parent.

### Repository Map
- `auto-compress.js`: main plugin entrypoint, token estimation, pruning, summarization, persistence, and cleanup.
- `README.md`: user-facing behavior, install/configuration, and contract notes.
- `docs/session-decisions/2026-05-29-0833-summary-backoff.md`: rationale for failure backoff and persisted failure state.

### Architecture and Important Files
- Persistent session state: `~/.config/opencode/logs/auto-compress/state/<sessionID>.json`.
- Retained summary chunks: `~/.config/opencode/logs/auto-compress/summaries/<sessionID>/<NNNNNN>.md`.
- Debug log files: `auto-compress.log`, `token-calc.log`, and prune snapshots under the same log root.
- State includes `summarizedIDs`, `summaryFailureCount`, and `contextLedger`.
- Legacy rolling `summary` is migrated into per-session summary chunks when present.
- Summary generation can use a configured model via `options.model`; otherwise it falls back to the active session model. Token estimation uses a configurable `tokenCoefficient`.

### Build And Validation
- No `package.json`, `Cargo.toml`, `pyproject.toml`, or `go.mod` is present in the repo root, so no repo-declared build/test commands were found.
- Runtime validation is via OpenCode plugin execution and debug settings such as `logLevel` and `debugTokenCalc`.

### High-Risk Areas
- `summarizedIDs` semantics in session state files.
- `experimental.chat.messages.transform` output shape.
- Tool-call boundary safety during prune cut extension.
- Failure backoff thresholds and hard-cap fallback behavior.
- Legacy summary migration into chunked summaries.

### Working Rules
- `logLevel: none` must not produce file debug output.
- `<system-reminder>...</system-reminder>` blocks are stripped before summarization.
- Session summary chunks are retained with bounded per-session retention.
- State and summary files are functional context artifacts, not disposable debug data.
- Old state and summary directories are cleaned up on startup when they are older than 30 days.
- Compaction thresholds and hard caps still use provider-reported context tokens; local estimation is used only to choose the prune cut point.
