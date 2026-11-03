# excerpt recovery retains a stale conflict beside newer failure

problem: after a full excerpt409, a retry's503/401/426 sets error but leaves
remote.conflict true. LoadedExcerpt independently renders both Failed and the
capture-refusal Fact, producing two recovery homes; update can offer reload
alongside retry/show-current. a successful Reload also preserves the previous
error while its new Capture read is pending.

source evidence: final-connections candidate8842e31,
`apps/web/src/components/resources/ExcerptDisclosure.tsx:49-61,94-103`.
first Capture GET with expected_capture_revision=1 returns409 E_RESOURCE_CONFLICT;
next same-capture read returns503 or426. both conflict and error remain. for
replacement: show-current fails503, its retry successfully resolves revision2,
and the following full revision2 read is held; the stale failure remains.

impact: misleading duplicate facts, competing verbs, and violation of update's
sole useful remedy. independent reviewer and root confirmed source; focused
both-engine baseline/repair is assigned before this candidate can integrate.

fix the read owner's transitions and single presentation branch. retain exact
frozen retry versus explicitly choosing current capture, clear obsolete failure
on successful replacement, and let current transport own recovery. resolved
when both engines show one current failure/remedy and no stale failure after
replacement acknowledgement; preserve identity guards and wake read behavior.
