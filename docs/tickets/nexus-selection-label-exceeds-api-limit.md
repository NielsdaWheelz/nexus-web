# valid nexus resource labels exceed journal admission

status: open · origin: 2026-10-03 source audit at `53a22f7ef1fb74f1b527a8d21a2fb53b52b73c4d` · area: nexus history

valid podcast titles can exceed the selection request's 2,000-character label
limit. rss titles remain whole in `services/podcasts/feed.py:168` and
`podcasts/ingest.py:212,249,289`; `db/models.py:627` stores media titles as text.
`resource_graph/resolve.py:306–308` retains the title in its label;
`services/resource_items/openables.py:49–59` and web `lib/nexus/rows.ts:247–260`
preserve that label. `components/nexus/useNexusController.ts:270` sends it whole.

`schemas/nexus_history.py:17` rejects the request before
`services/nexus_history.py:82` can collapse whitespace and cut the stored label
to 120 characters. history is not recorded; the existing invalid-request refusal
in `lib/nexus/useNexusFind.ts:113–120` reaches the workspace defect owner after
activation. this is source evidence; fresh runtime reproduction is not_run.
pr 410 already changed the older request limit from 120 to 2,000; this finding
does not reuse that historical production failure as current proof.

source design accepted for later runtime verification: remove only the label
field's arbitrary upper bound; keep its nonempty input constraint, existing
server snapshot normalizer and raw request-model replay hash. implementation
is deferred; fresh runtime reproduction remains not_run.

acceptance: a real ingested long-title episode selected through nexus records
and restores the bounded snapshot without a defect. exact-id replay remains
stable; changed raw label text beyond the stored prefix still mismatches without
writes. qualify unchanged short and blank-label behavior.
