# Session Decision Summary: prune cut point

Date: 2026-06-12 11:41
Base commit: 884b16e

## Context
The session investigated why auto-compaction refused to prune even when provider-reported context tokens were above the hard cap during a long tool-call-heavy session. The approved scope was to diagnose the exact cause first, avoid arbitrary fallbacks, and keep the existing tool call / tool response safety behavior intact.

## Changes Made
Updated `findCutIndexByEstimatedTokens()` to keep the estimator-selected `chosenIndex` instead of rolling the cut point back to the chosen message parent. Added temporary estimator and cut-point diagnostics during investigation, used them to confirm the root cause on the failing session, and removed those diagnostics once the fix was verified.

## Decisions And Rationale
The final cut-point failure was caused by the generic `parentID` rollback, not by token underestimation. Logs showed the estimator selected `chosenIndex=26` with a retained estimate close to the hard-limit target, but the parent lookup pulled the final cut back to `startIndex=1`, which made pruning impossible. Keeping `chosenIndex` is the smallest direct fix because tool-pair safety is already enforced later by the existing cut-index extension logic for tool results.

## Implementation Approach
Changed the cut-point helper so it returns `chosenIndex` directly once the retained-token threshold is reached. Kept the rest of the pruning flow unchanged, including the later tool-call boundary extension. Verified behavior with `node --check auto-compress.js` and with runtime logs showing pruning and summarization on the previously failing session.

## Files Included
- auto-compress.js: removed the generic parent rollback from cut-point selection so pruning can use the estimator-selected boundary.
- task.md: records the completed task, validation, and decisions for this session.
- decisions/2026-06-12-1141-prune-cut-point.md: preserves the reasoning and validation behind the cut-point fix.
- AGENTS.md: unrelated/pre-existing untracked repository file included to leave the repository clean.

## Commit Linkage
This summary is committed together with the implementation changes to keep rationale linked to code history.
