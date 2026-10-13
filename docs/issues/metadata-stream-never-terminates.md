# the metadata stream never terminates

**problem.** `/stream/media/{id}/metadata/events` is never terminal: the media
pane observes it for as long as it is open so later automatic jobs still show.
Behind the bff each open pane holds one vercel function invocation, ended at
280 s and reopened at once.

**impact.** Fluid compute bills the provisioned memory of each invocation for
its whole duration; plan quotas and concurrency for many idle streams are
unmeasured. A user with several media panes open holds that many invocations
around the clock.

**evidence.** `lib/media/mediaMetadataOperations.ts` (`isTerminal: () => false`),
`api/routes/stream.py` (`stream_metadata_events`), the edge harness's E20b
(a pane held open sees one planned cut every 280 s).

**owner.** The metadata slice: observe only while a job is active (end the
stream when no operation is pending and reopen on admission or on the next
detail read).

**resolved when** an idle media pane holds no stream (the hop log of the edge
harness shows no metadata connection for a pane with no active job), and the
vercel usage page shows no idle-stream invocations.
