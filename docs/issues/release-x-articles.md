# native x article release

this change shares wire 12 with the canonical x thread change. new closed import failure codes can crash
wire-11 clients; `android-v0.3.4` carries wire 11. publish the web, rebuilt firefox
extension and paired android apk for wire 12 with the api. older clients receive
the existing wire mismatch refusal and must update.

before activation, apply migration 0294 after canonical x source migration 0293 through the normal release controller:
stopped writers, verified backup, ancestry preflight and exact-head verification.
0293 has its own [source conversion prerequisites](release-x-thread-imports.md).
it creates empty article inspections and preserves old captures/annotations.
supersession owners are backfilled only from an original attempt or unambiguous
surviving job. unknown owners remain null and old uuid retries are refused;
new redirects retain their requester. no historical duplicate conversion occurs.

the feature currently reports articles unavailable through x's api. do not label
this release full article support; its external blocker is
[the official structure gap](x-article-body-is-not-ingested.md).
the combined article discovery/thread acquisition needs
[qualification within an authorized budget](x-author-thread-live-qualification.md);
local replay does not establish that boundary.

resolved after the paired clients/backend and migration are deployed, and an
installed-client status import opens the thread, exposes its separate unavailable
article import and recovery, and follows native deduplication to the saved thread.
production activation and installed-client acceptance remain owner release work.
