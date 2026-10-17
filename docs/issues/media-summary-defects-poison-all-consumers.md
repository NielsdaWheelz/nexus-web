# media summary defects poison all consumers

status: open; source-confirmed, live reproduction pending.
origin: 2026-10-16 mobile palette identity-design cross-review.
area: media summaries / failure ownership.

problem: `apps/web/src/lib/media/MediaSummaryProvider.tsx:60` stores one global
unexpected defect. the resolver assigns it at lines 100–103; `error(ids)` throws
it for every caller at lines 164–165, regardless of which ids failed. retry
invalidates entries but does not clear or supersede this defect (lines 116–123,
172–179). unrelated consumers can fail, and remounting a consumer under a local
boundary still reads the poisoned provider.

impact: one failed summary batch can affect every media-summary consumer. a
workspace title resolver cannot gain local failure isolation merely by adding
its own error boundary around this shared provider.

prerequisite: retain the distinction between modeled failures and unexpected
defects; do not silently turn an invariant violation into an empty summary.
proposed fix: scope failure to the read and affected ids, retain unrelated
summaries, and define an owned retry/reset transition that retires the failed
attempt. unloaded and confirmed unavailable must remain distinct; current
summary null denotes unavailable. the workspace projection uses an independent
identity read, so this repair is separate work, not its prerequisite.

acceptance: a defect in one requested batch is reported at its consuming scope,
unrelated identities remain usable, and a successful explicit retry can replace
the failed attempt without remounting the entire workspace/provider.
