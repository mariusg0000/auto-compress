# Active Task

## Goal
Update README.md and specs.md so they match the current plugin defaults, debug controls, and prune cut-point behavior, then commit and push the documentation changes.

## Constraints
- Keep documentation changes scoped to current behavior only.
- Do not change plugin runtime behavior in this task.

## Steps
- [x] Update README.md defaults and behavior notes.
- [x] Update specs.md to match current configuration and cut-point behavior.
- [x] Validate the documentation diff for accuracy.
- [ ] Commit and push the approved documentation changes.

## Subtasks
- [x] Fix stale install/config examples in README.md.
- [x] Fix stale defaults and runtime flow text in README.md.
- [x] Replace stale debug terminology in specs.md.
- [x] Add current cut-point behavior to specs.md.

## Implementation Decisions
- README.md now documents the plugin as an `opencode.json` plugin entry instead of a bare JSON array, because the previous example could be copied into an invalid config.
- Documentation now distinguishes configured examples from code defaults so the README reflects actual runtime fallback values and threshold behavior.

## Validation Plan
- [x] Review the final diffs against current code paths in auto-compress.js.

## Validation Results
Reviewed the README.md and specs.md diffs against `auto-compress.js` defaults, threshold handling, summary-model resolution, debug controls, and cut-point logic.

## Status
Active
