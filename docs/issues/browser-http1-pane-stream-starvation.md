# restored pane streams can starve ordinary browser requests

status: open

at `a4fc51261`, desktop workspace restoration mounts every media pane
(`apps/web/src/components/workspace/WorkspaceHost.tsx:80`). each starts a
nonterminal processing stream even for settled media
(`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:170`,
`apps/web/src/lib/media/useMediaProcessingStatus.ts:24-27`).
with six restored media panes, chromium's http/1.1 origin connections can all
remain occupied by these streams and the authenticated writing stream.

observed in the second full browser campaign on the same database:
`20261022-173144-f571bd29c0cd`, playback branches and current-source resume.
the actual fresh player get and unrelated reader/document-map requests stayed
unsent (trace send/wait/receive timings all -1). the bounded player read correctly
aborted after 2039 ms; no stale timed source was installed. the initial campaign
on the same build passed before extra fixture panes accumulated.

a bounded diagnostic reproduced the paused source and unsent read. closing two
unrelated mounted panes through their real toolbar controls aborted their
processing streams; the already pending player get immediately returned 200 and
playback resumed within the original 1500 ms assertion. cdp reported http/1.1.
closing an unrelated pane without a mounted stream did not drain the request.
private diagnostic log: `/tmp/nexus-playback-diagnostic-active-close.log`.

repair belongs to desktop media observation/transport ownership, not playback
intent ordering or longer descriptor deadlines. choose an explicit connection
budget or observation policy; do not silently discard source updates. disposable
cases must also close panes they do not need before starting their engine. with
that real-toolbar setup reset, all nine playback cases passed on the same held
runtime without changing assertions or deadlines. this does not fix the product
connection budget.

resolved when real http/1.1 desktop operation with six settled media panes and
the writing stream still admits reader and player requests promptly, including
a paused current-source resume and a fresh timestamp start of another source.
