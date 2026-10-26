# concurrent native normalization can publish a missing prefix

`Sync` is document-local; native workspace/share documents use one serialized
store. its mutex covers each operation, not a whole multi-step normalization.
in `81bf46590`, a backgrounded document can retain one in-flight scope step.

schedule: a writes an interval prefix; b starts that unfinished interval and
`scopeNormalizationReset` deletes the prefix; a writes its final suffix and
`scopeNormalized` marks it complete. publication can then expose missing text.
revocation followed by regrant of the same metadata digest permits a similar
stale-final-write schedule. this is a source-proven race, not a live loss report.

the store must verify exact contiguous normalized coverage from zero through
the final normalized length inside the marker transaction. a gap/overlap retries
derivation without a user-facing sync failure. use the same shared fixed SQL on
both hosts; no whole-source lease, generation registry or new recovery owner.
resolve with interleaved native document hydration/recreation and exact complete
coverage/publication checks, including same-digest readmission.

the source review also found that an invalid raw read was rechecked with three
separate bridge operations. another document could reset or repair the stage
between those reads, pairing old complete progress with a missing raw chunk and
reporting an ordinary handoff as a sync defect. the diagnostic now reads progress,
the pending interval and the offending raw chunk in one store transaction and one
native dispatch. this is a source correction; live interleaving proof is pending.

another reviewed schedule leaves staging at r after revocation erases its raw
rows and intervals. an already in-flight final text page can restore raw-complete
for r; no remaining intervals then makes reading completion vacuous. regrant can
return the same digest before the final fence. staging invalidation on effective
revocation and requested-cursor checks on metadata/text publication now prevent
that late suffix from skipping its durable prefix. an effective revoke is a new
blacklist marker or copied interval/text/progress/completion state to purge;
an unchanged repeated denial does nothing. revocation restarts all incomplete
staging, while independently authorized active readings keep their text.

publication also compares the existing replica store revision captured immediately
before its final request, before even accepting an already-active result. a known
withdrawal therefore invalidates an older final reply across same-digest repair.
unrelated authored edits can require another final request; writing never waits.
these are source corrections; runtime and native interleaving proof remain pending.
