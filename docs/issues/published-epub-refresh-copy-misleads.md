# a published epub says its refresh waits on an unsettled attempt

status: open
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness/defects.txt` N2)
area: resource items and actions (server) / web action copy

a published epub can never be refreshed (an epub publishes once). its resource
menu still lists "refresh source", disabled with "source refresh requires a
settled source attempt", though the attempt is settled. the server emits
`RefreshSourceAction` blocked `TemporarilyUnavailable` with
`expected_attempt_id` null (`python/nexus/services/resource_items/actions.py`,
the `RefreshSourceAction` arm), which `apps/web/src/lib/actions/project.tsx`
words as an unsettled attempt.

impact: the menu promises an action that will never become available and blames
the wrong cause. evidence: harness journey `R2.published-epub-refresh-refused`.

fix: a published epub carries no refresh action, or one blocked with a reason
that says epubs are not re-extracted; the copy follows the reason.

resolved when R2's menu shows no refresh for a published epub, or one whose
reason is that published epubs are not re-extracted.
