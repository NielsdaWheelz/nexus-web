# concurrent provider admission collides on canonical media

status: open · origin: 2026-10-04 cleanup/linear-01 live qualification · area: source admission

two concurrent url intents for a new youtube video can both miss reusable media,
then one returns 500 when its insert loses `uix_media_canonical_url`. add's normal
concurrency of two can trigger this with watch and youtu.be aliases. the loser
retains an unresolved row instead of joining the winner's media and attempt.

evidence: task-owned authenticated bff/api at delivery base `464098c11`,
2026-10-04 23:56:14 utc, request `aee7918d-de15-4119-86f4-eb151308669e`:
watch `abcdEFGhijk` returned 202; concurrent youtu.be returned 500.
`media_source_ingest.py:771-774` performs separate find/create steps;
`_new_media_from_spec:852` flush raised `psycopg.errors.UniqueViolation`.
receipt: `/tmp/nexus-linear-20261004/api-final.log` and mounted owner trace.
no worker or production writes were involved.

source qualification: six admission/identity function ast bodies equal
`f2167baf3`; this is a pre-existing race. replay locks viewer plus request key,
not canonical media. the shared integrity-retry table lists this constraint,
but url acceptance never enters that owner. receipt:
`/tmp/nexus-linear-20261004/provider-race-source-qualification.json`.

fix: give canonical provider-media acquisition one atomic owner. reuse the
winner's media and current attempt after a competing insert, without catching
unrelated integrity errors. coordinate with the separate joined-admission replay
key ticket so each accepted intent remains replayable.

acceptance: concurrent distinct-key aliases of a new provider target both return
202 with one media and one in-flight attempt/queue item; both exact keys replay
the admitted identities after settlement. no canonical-url uniqueness 500.
