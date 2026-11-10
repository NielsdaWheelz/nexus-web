# release finite foreground observation

the hard cutover removes passive stream endpoints, changes the authored
worker/native hello contract and removes obsolete notification triggers. activation
requires a paired api/web/android build under the existing release owner and the
wire revision's once-per-release rule: candidate wire 20/schema 0337 follows
metadata recovery's schema 0336 and shares its unreleased wire 20 bump. freshly
inspect the deployed release vector before activation. authored format stays 4. preserve local corpus,
pending source bytes and feed cursors.

the devbox frontend bridge serves the earlier wire19/schema0335 release. its
staged web operations and installed clients passed; the replacement coordinator's
first full paired live execution remains `NOT_RUN`. prepare one sealed web
candidate, then use `deploy/release.sh <candidate-manifest.json>` to run
prepare-web → backend backup/migration/release → activate-web → exact public
check. qualify that whole sequence with this release; do not activate current
web alone against the wire19 api.

before activation, qualify the notification cleanup migration against the existing
schema and populated backup under the normal stopped-writer release procedure:
application rows are unchanged; chat and background
job wakeups remain. verify missing expected objects fail migration. verify old
clients receive the update remedy and the new browser refuses an old shared worker
without opening a second incompatible storage owner. close all old nexus tabs to
replace their shared worker; pair the apk with the same wire build. do not purge
device data. local pending uploads can wait for foreground; they remain committed.

hosting, billing changes, quota recovery and production activation are outside
the implementation pr. local composition proof cannot establish provider billing
or deployed recovery. resolve after the paired release owner completes live
web/native/worker checks and records actual resource usage after quota recovery.
