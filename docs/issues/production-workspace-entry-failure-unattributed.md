# production workspace entry failure remains unattributed

problem: a fresh firefox tab opening the production root on 2026-10-28
restored a media route and rendered `the workspace stopped unexpectedly`,
with `details` and `activity` on an otherwise empty workspace. the reading
surface could not be inspected.

evidence: the visible route was
`/media/6887cccf-c090-41db-8a6a-32dbda49f9ef`, titled `Sword & Citadel · Nexus`.
a separate read of the public `/version` endpoint answered
`3d81ef45ef28f637a4de07c66ab172bbab9e22c2`. that identifies the current web
deployment, not necessarily the browser bundle that threw. local source was
`1b1e6ef71`. no initiating exception, failed request, or backend revision was
captured; native browser automation could not reliably open details or console.
this does not establish a service-wide outage or the cause of the failure.

follow-up: reproduce entry in this session, retain the first exception and
sanitized client report with actual bundle identity, and correlate any failed
request before changing an owner. the separately recorded workspace-reporting gap
is a source finding, not attribution for this event. the old activity fallback
was removed in `c11f07e49`; that does not establish this incident's cause or repair.
do not reset stored workspace state or discard writing merely to hide the trigger.

resolved when the initiating cause is established and the same entry/reader
journey succeeds after the owning repair, without losing existing writing.
