# joined url admission does not record its replay key

status: open, source-qualified; runtime not reproduced here.
origin: 2026-10-04 add-content backend review at `78b398f0c`.
area: url source admission / durable replay.

`python/nexus/services/media_source_ingest.py:786-793` joins a reused media's
in-flight attempt and returns before `create_attempt` persists the current
idempotency key at `801-812`. exact replay lookup at `493-499` searches only
attempts carrying that key. a second-key YouTube/X request therefore has no
durable replay receipt while it joins another request's work. replay after the
original settles creates a new terminal attempt, changing the admitted attempt
identity and adding another acceptance/history record. media/queue deduplication
still holds; this is not evidence of duplicate provider execution.

reproduction: admit a provider url under key a; while queued, admit the same
provider under key b; settle a; resend the exact key-b request. the second and
fourth responses name different attempts.

prerequisite: admit the source command's replay owner. record every accepted
viewer/key/intent, including joins, using the existing mutation-receipt primitive
or an equally explicit source-owned receipt. do not create a newer source attempt
over an in-flight fence just to store its key.

acceptance: a joined request replays its original admitted media/attempt identity
both before and after settlement, adds no acceptance/history row, and admits no
new job. changed intent under that key still conflicts.
