# media metadata

`metadata_enrichment.py` owns bibliography input, prompt and acceptance;
`x_titles.py` owns grounded x naming. `tasks/enrich_metadata.py` composes generation,
contributor resolution and atomic publication. `metadata_operations.py` owns admission
and projections of retained queue jobs. jobs are the operation store; there is no
quality-review workflow.

## bibliography contract

the model uses its best judgment, saved context, learned knowledge and useful
available tools. its closed result has exactly eight required nullable keys:
`title`, `contributors`, `original_published_date`, `edition_published_date`,
`edition_isbn`, `publisher`, `language`, `description`.

non-null scalars replace; null preserves storage. each listed contributor role
replaces its complete ordered credits; omitted roles preserve. empty lists,
duplicate roles, duplicate identities within a role, unknown keys and unoffered
handles reject the result. one person may hold several roles. existing handles
identify the same person, including changed credited spelling; they cannot rename
a placeholder into an unrelated author. contributor resolution remains owned by
`contributors.py`. there is no clearing. all-null succeeds unchanged and stamps
completion. an execution success certifies no bibliographic fact.

original date means a book's first BOOK publication, a collection's own first
book publication, or a separately saved essay's first publication, including
periodicals. translations and reprints retain the original work date. edition
date, isbn and publisher describe the encountered edition. preserve supported
calendar precision; do not borrow a container date or invent a month/day. generated
isbn must be checksum-valid isbn-13. language is lowercase iso 639-1. descriptions
are neutral, factual, 1–3 sentences, without marketing, markup or uncertainty reports.
a piece cannot publish edition date/isbn/publisher or publisher credits.

## research

the existing policy selects codex personal `gpt-6-luna`, `xhigh`, 300 seconds,
32,768 utf-8 input bytes. no substitution. input includes complete credit rosters
and offered handles, identifying source facts and up to 1,000 opening words.
source reads are bounded; descriptive current values are explicitly shortened
hints, never complete replacement values. the private fingerprint covers complete
facts and current publication identity, including values beyond shown hints.

`MetadataResearch` exposes scoped `nexus.document.search` and
`nexus.resource.read`, public page reads, and configured public search. absent
search is not advertised. optional search/read refusals, unavailability and timeout
are typed tool results: continue with available context or return null. internal
conversion, database and claim failures are not successful research. public queries
contain necessary public identifying strings, never private passages or ids.
canonical background retrieval does not materialize source html/native excerpts.
rich citation consumers retain their separate capture contract and read snapshot.

## admission and publication

`POST /media/{media_id}/metadata-enrichment` requires
`{expected_job_id: uuid | null}` and returns 202 with
`{data:{media_id,job_id,last_enriched_at}}`. media locking serializes admission.
a lost-response resend joins the latest accepted request. queued/running/retry work
blocks duplicate admission. an explicit update replaces held metadata with one new
job, atomically superseding the held result while retaining its failure diagnostics.
if reviewed repair resumed first, the command joins that active job.

bibliography admission freezes media, purpose and part-definition version, not
reader generation. changed admitted part definition or x-title source attempt
settles superseded. current bibliography/source drift discards the candidate and
reruns fresh research in the same job. every publication rechecks access,
eligibility, purpose, frozen constraints, full fingerprint and exact execution.
source-family/media/publication locks precede the queue claim. validate all credits
before publishing facts. facts, invalidations, completion stamp and queue result
commit in one fresh transaction, without network calls. unchanged credits cause no
churn; unchanged title causes no reader-title write. successful stamps increase
strictly even when no field changes.

x titles remain grounded in the captured primary authored text and supplied image
descriptions, with the existing missing-source and source-label policies. a naming
job freezes the exact source attempt. metadata never owns source text, provider
identity, urls, reader generations or containing-work metadata.

## observation and repair

operation wire variants are queued, running, recovering, waiting, held, completed,
failed. held includes a typed reason and held_at, has no completion time, and is
unfinished but neither executing nor claimable. completed bibliography contains
only purpose, completed_at and changed_fields. generic generation/tool audit remains.

`POST /media/observations/resolve` accepts 1–100 unique media ids and returns
ordered `{media_id, observation}` items. each authorized repeatable-read observation
combines processing and metadata; missing/unreadable ids return null. invalid,
duplicate, empty and oversized inputs return structured 400. reads admit no work.
one document/account owner batches due presented main/child/inspector interests
on aligned 10/30-second boundaries. processing `work_in_flight` or metadata
`work_in_flight` selects 10 seconds; settled or held-only subjects use 30.
metadata derives that boolean from active queue work, not `unfinished_count`,
which truthfully includes held work. a busy sibling never accelerates settled ids.
attention joins current reads and wakes omitted interests; immediate demand can
precede the next shared boundary closely. hiding suspends observation and retains
accepted snapshots; successful null clears private state. reader invalidation
compares publication facts and coalesces changed children, never operation phase.

`GET /media/{media_id}/metadata-enrichment/{job_id}` returns the exact authorized
accepted job, even after newer work. deliberate interest survives pane closure
while foreground; background retains it without requests and return checks it.
one held notice releases that interest; mounted inspection keeps observing held
work every 30 seconds. supersession is silent. account teardown cancels reads and
clears only its entries. no recovery inventory or passive stream is introduced.
an operator resume with every pane closed need not toast; reopening reads durable state.

copy distinguishes `metadata updated`, `metadata unchanged`, `waiting to retry`
and `metadata update needs a repair`. failures retain exact update/status actions.
reason copy comes from typed causes, never parsed trace text. routine waiting
preserves focus and geometry. the nullable model contract deliberately cannot clear
a last wrong value without a replacement; another update can repeat a model mistake.
