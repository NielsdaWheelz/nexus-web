# workspace session failed save discards dirty state

status: open · origin: 2026-10-02 cleanup source audit · area: workspace persistence

`apps/web/src/lib/workspace/useWorkspaceSession.ts:33–38` clears the pending
timer and assigns `lastSavedRef` before the request succeeds. this records a
scheduled snapshot as acknowledged persistence. its catch calls only
`handleUnauthenticatedApiError`; that helper returns false for other errors
(`lib/auth/UnauthenticatedApiBoundary.tsx:19–22`), and the result is discarded.
the user receives no save-failure feedback.

after a failed debounced save, pagehide/hidden cannot flush the dirty snapshot:
the guard at `useWorkspaceSession.ts:54–55` requires a pending timer. with no
further edit, reloading restores the older server state and loses workspace
changes. the keepalive branch also marks saved before its request settles
(:60–61). evidence is source control-flow analysis, not a completed browser
failure-injection receipt. no matching ticket exists on origin/main
`2b7d7ac899826f0f4b03d271fd606ea28c53d207` or the current worktree.

reproduction: with working session get/save, save a baseline; make one workspace
edit, fail its debounced PUT with a non-auth network/server error, then restore
connectivity without editing again. hide/reload the page. no flush request is
sent and the previous server snapshot returns.

prerequisite: resolve the separate missing `workspace_sessions.order_key`
mapping so restore can succeed normally. keep this fix separate from that
one-line schema/model repair.

smallest owner fix: in `useWorkspaceSession`, distinguish dirty current state
from the last successfully acknowledged snapshot. preserve failed state for
retry and pagehide flush independently of the debounce timer; surface non-auth
failure and retry through existing feedback (`store.tsx:842`,
`components/feedback/Feedback.tsx`). retain auth handling. ensure overlapping
saves cannot acknowledge or persist an older snapshot over newer intent;
serialize only if needed for that actual ordering invariant. no database,
transport redesign or general persistence framework is needed.

acceptance: an injected failed PUT produces actionable feedback, remains dirty,
and a subsequent retry or pagehide saves the latest state; successful reload
restores it. verify two edits while a save is in flight preserve newest state,
ordinary debounce/keepalive behavior, and existing auth handling. record live
receipts; temporary failure injection stays outside production.
