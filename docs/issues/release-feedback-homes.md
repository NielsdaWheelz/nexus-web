# release feedback homes

the hosted interface, android packaged interface and firefox extension must
ship together. the page also expects the authored worker's `SyncFailure`
contract; navigation alone can leave an old shared worker running. the existing
[import acquisition release](release-import-acquisition.md) rides this release
at wire 18, the first break after deployed wire 17. feedback does not bump it
again. a wire-17 client is refused at the edge.

stage hosted from the merged source sha through the deployment controller
([architecture](../architecture.md)). build the apk and xpi from that
same sha, including their packaged web assets; the owner signs the xpi. promote
hosted and release the paired apk and xpi together. merging this branch deploys
nothing. retain the previous release's exact hosted and client artifacts.

before promotion, establish the actual deployed release vector and migration
ancestry. the last recorded deployment is schema 0329, wire 17 and authored
format 4 ([local-first closeout](release-local-first-writing.md)); source history
is not proof of current production state. this feedback change and the included
import acquisition change add no migration, persisted format, environment or job
payload change. preserve pending authored commands and synchronize provisioned
devices; drain uncommitted writing before restarting the browser session. restart
the browser after the paired release to retire the old shared worker.

qualify the paired artifacts: unavailable-session playback resumes from its
descriptor; refused and unknown saves keep their distinct outcomes; installed
sign-in shows its pending state; account conditions and stopped-store copy match
the owned state; copy recovery preserves uncommitted text; phone slips clear
fixed controls and the keyboard. run the acquisition checks in its release
record as well. physical safe areas and actual assistive speech keep their own
qualification records until observed on those devices.

rollback the hosted build, apk and xpi to their retained previous release
together. this is a code-only rollback only while the verified release delta has
no durable-format change; re-evaluate that premise if more changes join the
release. do not delete local commands or restore old local stores to make a
rollback appear successful.

resolved when the paired artifacts are released and these client observations
are recorded at their actual scope. implementation qualification does not close
production delivery.
