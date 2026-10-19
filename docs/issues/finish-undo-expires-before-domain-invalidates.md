# keep the exact finish inverse available without a timer

status: open; included in the feedback cutover
origin: 2026-10-16 feedback specification review; source at `69c00182c832`
area: consumption / finish feedback

problem: the only offered exact finish inverse expires independently of whether
the operation remains undoable. generic unread/reset is not the same inverse.

evidence: `apps/web/src/lib/consumption/state.tsx:117-144` captures the finish
receipt in an undo callback and publishes it only as a hud.
`apps/web/src/components/feedback/Feedback.tsx:141-145,155-161,172-186` expires
or evicts the hud and removes it on activation even if undo fails.
`python/nexus/services/consumption/state.py:136-168` restores the prior status,
completion and removed lectern placement, subject to the finish revision.
this is source evidence, not a live reproduction.

prerequisites: retain that exact receipt and the existing revision fence.
fix: use an untimed, dismissible offer; withdraw on acknowledged undo or owner
invalidation. prevent dismissal while undo is busy; unresolved inverse writes
become owner conditions. a retryable failure retains the permitted inverse. reload
persistence for this optional offer is outside the approved two-admission scope.

acceptance: after ten seconds and a receipt burst, undo still sends the captured
finish receipt. a lost response can be retried under its existing replay rule;
a superseding edit cannot undo the new state. explicit dismissal removes only
the offer, not domain state.
