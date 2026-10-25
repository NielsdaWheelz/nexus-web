# admitted writing can lose its retry owner

`apps/web/src/lib/notes/runtime.ts` currently marks `close()` retired before
draining `tail`; queued, already accepted writes then reject on the retired
check. failures before a commit frame is installed publish a local error, but
`retry()` has no failed frame to retry. the visible yjs document can therefore
contain edits that were neither committed nor retryable.

drain accepted work or retain its owner on close. retain the failed preparation
until its same intent becomes a frozen commit frame. prove local read/preparation
failure followed by retry and provider unmount during queued writes preserves
every accepted edit. do not add persistent recovery.
