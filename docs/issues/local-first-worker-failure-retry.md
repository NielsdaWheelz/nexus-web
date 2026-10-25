# terminal shared worker failure needs live copy/restart proof

an opened worker can stop after the runtime retains its store handle. formerly
`worker.onerror` rejected only current requests; future calls could hang forever.
the client now remembers terminal failure, rejects future calls deterministically,
and limits unanswered RPCs. the runtime retains the accepted input and uncertain
command; a terminal fault exposes copy and guarded restart, never an inoperative
retry. this is a deliberate manual recovery contract, not a worker supervisor.

the ignored `authored-lifecycle.spec.ts` terminates the actual production shared
worker through its owned profile's devtools target, edits the mounted note,
checks retained words/copy/absence of fake retry, and dismisses the real reload
loss guard. lab26 (`20261025-152718-33b84520e084`, source `ca2558c79`)
passed terminal-failure detection, retained input, copy and absence of retry,
then failed waiting for the reload loss dialog.

the workspace and shelf never register the writing runtime with `WorkGuard`.
only `app/share/ShareCapture.tsx:115` registers its saving/error state;
`lib/unsavedWork.tsx` installs `beforeunload` from registered risks. the separate
`hasUncommittedWriting()` check protects automatic updates and fatal render
recovery, not an ordinary editor reload. centralize that existing registration
across all three hosts. resolve after the real terminal-worker case preserves
the input when restart is cancelled; static and SQL-only checks are insufficient.
