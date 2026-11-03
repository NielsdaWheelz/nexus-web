# suspended source falsely claims exhausted retries

problem: mediaSourceLine says automatic retries are used up whenever processing
status is suspended. the status proves dead source work without a readable
publication, not retry exhaustion.

evidence at90b6bc5/14400: `apps/web/src/lib/media/mediaErrorMessage.ts:35-36`;
`python/nexus/services/media.py:187-193` returns suspended for repairable/unreadable;
`services/source_attempts.py:228-242` defines repairable as latest in-flight
attempt joined to its dead job. `jobs/process_executor.py:154-156,185-188` emits
resource failures with Memory/Time dimension; `jobs/worker.py:190-198` marks those
failed jobs dead immediately through dead=dimension is not None.

fix: retain `this import stopped before it finished.` and omit the unproved
reason. retain actual server recovery authority and no new retry behavior.
resolved when the source failure Line makes no retry-exhaustion assertion, with
the immediate resource-failure schedule recorded as source proof. no real
resource-exhaustion runtime has been induced.
