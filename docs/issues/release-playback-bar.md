# paired playback release

pair api/workers/hosted web, the signed android apk with packaged web assets,
and the rebuilt/signed firefox xpi from the same merged source. playback adds
required nullable `MediaSummary.show` and removes audio-preview wire/bridge
operations. it rides acquisition/feedback's pending wire 18. the observed hosted
release `e505409d1e6af6d6f96c0741d916e1e453f9b7b1` uses wire 17; recheck the
release boundary before shipment. hosted identity is not an installed-client
census. merging this cut deploys nothing.

follow [feedback homes](release-feedback-homes.md),
[import acquisition](release-import-acquisition.md),
[closed media kind](release-media-kind-closed.md) and other pending main release
preflights. establish actual database ancestry before staging. playback adds no
migration or saved-catalog format; format remains 2. pause the old service and
preserve installed queues, pending listening/completion and authored commands.
apply [queue conversion](release-playback-queue.md) duties where the installed
source requires them. clearing app data or a clean install proves no preservation.

wire 17 clients receive 426 until updated. their saved catalog is incompatible
until one successful online rebuild. copy says `saved catalog needs an online
rebuild.` and `it rebuilds when you connect.`. this retires catalog readability,
not downloads, queues, pending progress or authored stores. verify rebuilt show
identity and reopen episode indexes offline. keep incompatible bytes; add no
compatibility reader or forced-empty startup.

build and release the extension too: it sends the wire header. the owner signs
and installs paired clients and restarts the browser session after preserving
pending writing, so the authored worker changes. retain exact previous hosted
and client artifacts. rollback follows the combined release's actual migration
and store constraints; no playback migration does not prove code-only rollback.

owner checks remain: prototype agreement in all three rooms, real media-key
resume, screen-reader output/focus, the signed apk on the existing handset,
real scrollbar dragging across the rail edge and browser-history accelerators
with the rail focused. retain [desktop player](release-desktop-player.md) and
the narrower qualification records until their actual observations pass.
headless lab success does not establish those checks or production delivery.
resolve after the paired release, catalog rebuild and installed observations.
