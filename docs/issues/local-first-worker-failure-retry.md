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
loss guard. it has not run yet. resolve after that real target case passes; the
static gate and SQL-only cases do not prove this lifecycle.
