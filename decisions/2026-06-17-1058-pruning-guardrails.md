# Session Decision Summary: pruning guardrails

Date: 2026-06-17 10:58
Base commit: 2ece8fb6dde50e3b42d48084b3c9eeeeacab8bc3

## Context
The user asked to make the pruning contract explicit after repeated debugging showed that provider context must decide when compaction happens, while the existing software estimator must keep deciding the cut point. The goal was to leave durable comments in the code so this split is not “optimized away” in future edits.

## Changes Made
Added visible guardrail comments in `auto-compress.js` near the provider-context threshold check, the estimator-based cut selection, and the final provider-context log.

## Decisions And Rationale
Provider-reported context remains the trigger for summarization because local context estimation had already failed in prior experiments. The cut point still uses the existing software estimator because that is the implementation currently in place and it matches the requested contract: provider decides when to compact, estimator decides where to cut.

## Implementation Approach
Kept the current pruning logic unchanged and inserted comments directly beside the relevant branches in the transform hook. The comments state the division of responsibility plainly so future edits do not accidentally replace the provider trigger or the estimator cut logic.

## Files Included
- `auto-compress.js`: added the permanent guardrail comments in the pruning flow.

## Commit Linkage
This summary is committed together with the code comments to keep the rationale attached to the pruning contract.
