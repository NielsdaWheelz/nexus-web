# Oracle

status: reauthored (cleanup/oracle-reauthor, migration 0262) · 2026-10-04

The oracle answers one question with a folio: an engraved public-domain plate, a
Latin motto, an argument, three passages (descent, ordeal, ascent) drawn from a
curated public-domain corpus and the asker's own library, marginalia, an
interpretation and three omens. It is three concepts, each with one owner.

## Corpus — `services/oracle/corpus.py`, `corpus.json`

`corpus.json` is the truth: 19 works (title, author, media kind, download url) with
87 passages (key, label, tags, curated quote), and 36 plates (key, artist, title,
year, attribution, tags, size, source page, image url, licence). The plates are
static web assets, `apps/web/public/oracle-plates/<key>.jpg`, served immutable
(`next.config.ts`); new bytes take a new key, so a plate URL never changes its image.

The database holds a projection of the file: the system library
`system_key='oracle_corpus'` holding one ordinary system media per work,
`oracle_corpus_sources (work_key → media_id)`, and `oracle_passage_anchors` (one
per passage: label, quote, tags, and FK-free cache pointers to the chunk and
evidence span of its work's current index that quotes it). Corpus text lives in
the shared content index like any media; chips open the real reader.

`seed` (the operator command below) converges the projection while the app is
live: per work, in its own transaction, it accepts the system url source when the
work is new or its url or kind changed (the superseded media is unfiled, not
deleted), repairs a failed ingest, requests a reindex when the work has no ready
active-model index and none is in flight, files the media, and upserts anchors; a
changed quote or a failed anchor is pending again. Anchors no longer in the file
are deleted. Ordinary workers ingest and index. Nothing publishes the corpus.

Anchors heal lazily: the reading job's `refresh_anchors` re-resolves every pending
anchor and every resolved one whose chunk left its work's ready active-model index
(a reindex or model cutover). An anchor whose work is not indexed waits pending; a
quote found in no chunk is failed until the next seed. The matcher folds quotes,
dashes and archaic contractions on both sides, tries the quote's first 80
alphanumerics verbatim, then a token window of n−2…n+4 tokens sharing a common
subsequence of at least max(6, 78% of n) with the quote's first n ≤ 18 tokens.

`rank_passages` scores every resolved anchor by its chunk's cosine similarity
under the active model plus two per tag shared with the question's words, keeps
one per work, and offers six. Fewer than three is the reading's typed failure
`E_ORACLE_CORPUS_NOT_READY`. The plate is the one sharing most tags with the
question's words and every offered passage, ties broken by key; it is chosen
before the model sees the passages, so the model can write to it.

## Reading — `services/oracle/readings.py`, `synthesis.py`

`oracle_readings` is the reading: `pending` until one transaction makes it
`complete` (folio fields, `omens`, `plate_key`, `plate`, `passages`, three citation
edges) or `failed` (`error_code`, `failed_at`). Scalar facts are typed nullable
columns; `passages` is jsonb, a list of `OracleStoredPassage` (prose, the `ordinal`
of the reading's own citation edge, and captured citation facts, null for every
published reading); `plate` is jsonb, the `OraclePlateOut` publication showed (null
for history whose log never captured one). Each jsonb shape has that one pydantic
owner (`schemas/oracle.py`). History migrated by 0262 may be partial: any fact null,
fewer than three passages, a `complete` row without a motto, or `streaming` — a
stored `streaming` row, or a `pending` one whose retired log had started
(`started_at`, its meta event). Nothing writes `streaming` or `started_at` now; the
job still owns a started pending reading and settles it.

`POST /oracle/readings` takes a question and a required `Idempotency-Key`. The
question is trimmed of Unicode `White_Space` at both ends (U+0085 goes, U+FEFF
stays; the browser counts with the same rule) and must then be 1–280 code points.
Creating is one transaction under an advisory lock per viewer: the viewer's
reading under that key, whatever its status or question, is the answer and
nothing is enqueued; otherwise folio number max+1, the row with its key (unique
per viewer), its job, and the viewer's membership in the corpus library (so every
asker's search and chips reach the corpus). The route acknowledges
`{reading_id}`; the browser mints one key per press.

The job (`oracle_reading_generate`) publishes a journaled outcome without
dispatch; an uncertain dispatch without local recovery raises and the job
dead-letters. Otherwise it prepares a snapshot — one query embedding, refreshed
anchors, the public lane, the personal lane (the viewer's visible media and notes,
corpus media excluded in SQL, four distinct owners), the plate — and dispatches it
once through the durable generation contract; a replay decodes the snapshot from
the frozen admission and never retrieves again. `synthesis.py` owns the prompt,
the strict output and every reading rule (argument 80–180 chars beginning "Of ",
motto, gloss, one of the 24 themes, three distinct offered passages one per phase,
a user passage when one was offered, no URLs, citation markers or four-word
windows of an offered quote); any violation is `invalid_output` with no repair.

Publication re-refreshes anchors and replaces the reading's citation edges with
three (ordinal = phase: title = attribution, excerpt = quote, section label =
locator), with the folio fields, the plate's current record and the three stored
passages; a cited target that vanished during
generation fails the reading `E_GENERATION_SOURCE_CHANGED`. Reads project the row;
only navigation is current. A passage's chip is the reading's own edge at its
`ordinal` (captured facts overlay its ordinal, role, hover and deep link), shown
when it has a reader locator; a passage with no such edge but a saved target
hydrates that target without writing an edge, shown when it has a locator or an
href; otherwise the passage is typography. Detail and summaries show the captured
plate, else (history without a plate event) `plate_key`'s current `corpus.json`
record, so plate keys are permanent; concordance compares `plate_key`. Concordance is one query: the viewer's other complete readings with
a motto, scored 2·shared plate + 2·shared theme + shared cited targets, top five.

Clients follow a pending or streaming reading over
`GET /stream/oracle-readings/{id}/events`: each frame is the whole
`OracleReadingOut` (`state` on change, `done` once it is complete or failed),
pushed by the `oracle_readings` status NOTIFY.

## Operator

After a release that changes `corpus.json` (or to heal failed anchors), run
`python -m nexus.services.oracle.corpus seed --owner-user <uuid>` once inside the
running background worker, with the production owner's user id
([deployment.md](../../deployment.md#oracle-corpus-seed) has the host command).
It is idempotent and safe while every writer runs; it prints its counts. The
release identity carries no corpus digest (candidate manifest schema 3).

## Assumptions

Owner questions this rewrite answered by assumption (spec §7; reversible in review):

1. Multi-user: consulting joins the viewer to the corpus library as `member`, so
   the corpus enters their search and library list as it does the owner's. The
   membership is permanent (no leave path; system libraries refuse member
   removal) and shares nothing between askers: highlight visibility ignores
   system libraries, so no asker sees another's highlights on the corpus works.
2. The app seeds and heals its own corpus; fewer than three rankable passages is the
   reading's typed failure, not a global gate.
3. A folio shows the curated quote; the works stay ingested for the reader jump
   and the ranking embedding.
4. The event log goes (its display is folded into the row); push stays as a
   status-snapshot stream. Omens are a column.
5. Generation conforms to the shared durable contract's minimum arms; a dead job
   leaves its reading pending (ticketed).
6. Plates are static web assets; a plate change is a web deploy.
7. The atlas has one global frame and no ETag; the readings layer stays.
8. Failed readings open from the aleph; readings cannot be deleted.
9. The 24 themes stay, owned in python and the DB CHECK.

## Owner decisions (2026-10-04)

1. The per-viewer idempotency key stays (above): a replay, pending or settled,
   returns the first reading and enqueues nothing; another viewer's same key is
   their own reading.
2. One landing (combined with simplify-04, 2026-10-04): claude owns it; codex's
   102989a8 does not land. The row materializes simplify-04's qualified fold of
   the event log: 0262 folds every reading once (meta, bind, argument, plate,
   passage, delta, omens and done replacement rules; nullable and partial facts;
   event-only citation targets; captured passage, hover and plate display; a plate
   without a plate event keeps current corpus metadata) into the row, then drops
   the log, folio rows and plate table. Navigation stays current: the owned phase
   edge wins, else the saved target is rehydrated without inserting an edge, else
   typography. Historical `streaming` and partial rows stay renderable; stored
   status is kept (pending plus meta displays `streaming` without changing what
   the job owns). Publication captures the plate too, as simplify-04's did. The
   equivalence proof against simplify-04's own projection over its 0259 backup is
   listed in docs/tickets/oracle-0262-production-preflight.md.
3. No loss at release: 0262 refuses, before any write and with counts and sample
   reading ids, on a held claim (a running job with an unexpired lease) or an
   unfinished job whose journal the new worker cannot resume (an admitted or
   completed generation in the retired snapshot or outcome shape; a completed
   failure is resumable), and on any fold inconsistency (its docstring lists them,
   including a plate whose image identity maps to no static key). Pending jobs,
   expired claims and their journals carry over; the new worker settles them. It
   cancels no reading and deletes no job, journal or key; keyless readings stay
   keyless. `E_RATE_LIMITED` becomes `capacity_unavailable`. The release crossing
   0262 stops the api and lets the old workers finish every oracle job before it
   stops them (`deploy/hetzner/release.py`), so production meets neither refusal.
