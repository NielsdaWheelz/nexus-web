# reading preparation restarts after a busy status read

on source `37d2e45de`, `Sync.run` clears its reading normalizer after any
`scopeStep` failure. a status request can return ordinary capacity-busy before
touching that normalizer. the next same-revision attempt resets the incomplete
interval, deleting its normalized chunks and beginning again. repeated refusals
can prevent a large interval from finishing; raw text, completed intervals and
authored writing remain intact.

the installed clients alternate reading-preparation busy states. this source
defect is confirmed, but their exact cursor history is unobserved; do not infer
that either personal client is currently looping from that status alone.

repair the exception boundary in `apps/web/src/lib/authored/sync.ts`: retain
valid state across failed observations, detach it before mutation and restore
it only after every corresponding write commits. revision changes, effective
revocations, failed persistence and structural invalidation must discard it.

resolve with retained partial progress across a busy status read, safe restart
after failed normalization persistence, unchanged revision/revocation fences,
and useful continued preparation on the paired installed clients. no timer,
storage-format, authorization or capacity change is selected.
