# release import acquisition

pair api, workers, hosted web, the android packaged bundle and the firefox
extension at wire 18. deployed wire 17 (see `release-local-first-writing.md`) is the
last release; this is the first break after it, so it bumps once, and later
breaks before the next release ride 18.

the break: acquisition sends library ids, not order revisions. `POST
/media/from-url`, `POST /media/from-x-capture`, upload confirm and extension
confirm take `{expected_removal_revision, destinations:[library_id]}`; podcast
admission and podcast import retry drop `expected_order_revision`;
`GET /libraries/destinations` and `GET /extension/library-destinations` drop
`order_revision`; `GET /imports` admits `view=Recent`. a wire-17 client is refused
with 426 at the edge; an old extension shows its update message. no migration,
stored format, env or job payload changes.

it rides the feedback-homes paired release (`release-feedback-homes.md`, written by
that change): stage hosted from the merge sha, build the apk from the same sha so
its packaged bundle carries wire 18, build the xpi from the same sha at its current
manifest version, owner signs it, then promote hosted and release the apk and xpi together.
this lane deploys nothing. if feedback-homes ships first without this change, this
release runs the same steps alone.

resolved when the paired deployed artifacts answer wire 18 and, on each client,
two links added to one named library in one submit both land (add panel, android
share, extension capture into a chosen library), a removal mid-batch still refuses
the rest, and placement still refuses a stale order revision.

rollback: redeploy the previous hosted build with the previous apk and xpi; nothing
durable changed, and revisions written meanwhile stay valid to the old code.
