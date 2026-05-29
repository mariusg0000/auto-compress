# Session Decision Summary: Summary backoff on failures

Date: 2026-05-29 08:33
Base commit: 573f0b7

## Context

The session focused on correcting compaction behavior when summarization fails. The prior behavior pruned old messages even when no new summary was produced, which could remove context fidelity during temporary model or API failures. The requested constraint was to keep implementation simple and avoid introducing separate failure-pruned tracking structures.

## Changes Made

Implemented adaptive failure backoff in the compaction threshold logic and persisted failure state per session. Added two new plugin options, computed dynamic effective thresholds from failure count, skipped prune on summarization failures while under a hard message cap, and forced fallback prune only when the hard cap is exceeded. On successful summarization, the failure backoff resets immediately and pruning returns to normal minContextMessages.

## Decisions And Rationale

The core decision was to prioritize short-term context preservation during transient summarization failures while retaining a hard safety limit to prevent unbounded growth. Failure handling now increments a persisted counter and relaxes the prune trigger progressively. This aligns with the requirement to move both thresholds upward gradually and revert to normal limits as soon as summarization succeeds. A deliberate trade-off was accepted: in hard-limit fallback, messages pruned without a fresh summary are still marked as summarized IDs to keep behavior simple and avoid extra state complexity.

## Implementation Approach

Extended session state schema to include summaryFailureCount in both load and save paths, with numeric sanitization and non-negative clamping. Added option parsing for failureBackoffStepMessages and failureBackoffMaxOffsetMessages. In the transform hook, computed sanitized step and max offset, derived currentBackoffOffset, effectiveMaxMessages, hardMaxMessages, and hardMinMessages, and used effectiveMaxMessages as the early return threshold. Added hard-limit-aware retained-message target selection for prune cut computation. Wrapped summarization failure handling with two branches: skip prune and persist incremented failure count when under hard limit, or force prune to hardMinMessages with incremented failure count when hard limit is exceeded. Reset failure count to zero on successful summarization and persisted it with summary updates.

## Alternatives Considered

Considered introducing a separate hardPrunedIDs bucket to distinguish truly summarized content from fallback-pruned content. Rejected for this iteration because it adds schema and filter complexity without immediate operational benefit for the requested behavior. Also considered fixed failure thresholds independent of offset, but rejected because the requirement explicitly asked for offset-based growth only.

## Files Included

- auto-compress.js: added adaptive failure backoff configuration, persisted failure counter, dynamic thresholds, and revised failure/success prune behavior.
- docs/session-decisions/2026-05-29-0833-summary-backoff.md: records rationale, trade-offs, and implementation details for this session.

## Commit Linkage

This summary is committed together with the implementation changes to keep rationale linked to code history.
