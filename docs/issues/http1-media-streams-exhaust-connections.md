# media streams can starve ordinary requests over http/1

problem: retained media panes open persistent processing streams alongside account
streams. multiple browser tabs can exhaust the origin's http/1 connection budget.

evidence: `apps/web/src/lib/media/useMediaProcessingStatus.ts:25-27` opens one
nonterminal stream per mounted media. private lab run
`20261023-182610-21bed88a5969`, passive-selection trace, has active writing,
suggestion and media streams across both tabs while ordinary playback-session
reads and summary requests never receive a response before the 60s case deadline.
this is consistent with the [documented six-connection limit across tabs](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

impact: locally served http/1 workspaces with retained readers can stall queue,
resource and navigation requests. production http/2 behavior was not measured.

resolve by giving the realtime owner a bounded composition that preserves
ordinary request capacity on supported transports, or by establishing http/2 as
an enforced serving contract. do not add player-specific retries or browser
connection-limit flags. prove multiple tabs with retained media panes continue
reading and editing through the real supported server.
