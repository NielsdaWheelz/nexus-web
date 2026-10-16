# media metadata

`services/metadata_enrichment.py` owns bibliography; `services/x_titles.py` owns
grounded x titles. each owns bounded input and strict generated-output acceptance.
`tasks/enrich_metadata.py` composes them with
the contributor owner and generation service. `services/metadata_operations.py`
owns the operation: admission and enqueue, the setwise projection of existing jobs
for detail, streams, imports and history (no shadow activity state), and personal
review of an exact no-findings result with its removal with viewer/media state.

## bibliography

- `original_published_date`: a book's first **book** publication, excluding prior
  serialization, broadcasts and lectures; a collection's own first book
  publication; a separately saved essay's first publication, including periodicals.
  other media use the identified item's first public release.
- `edition_published_date`: the encountered edition/version's publication.
- `edition_isbn`: canonical checksum-valid isbn-13. source adapters may normalize
  isbn-10; generated output must already be canonical.

translations and reprints retain the work's original date. container format does
not establish work type. preserve year/month/day precision through
`schemas/publication_dates.py`; never infer publication from file or acquisition
times. lists, search, author chronology and recency use the original date without
an edition fallback. source edition observations retain their own ingestion rules.
row formatting and retained-summary freshness belong to the
[library presentation contract](library.md); the metadata overlay keeps full dates
and all credits.

generated json has exactly eight required nullable fields: title, contributors,
original date, edition date, edition isbn, publisher, language and description.
`schemas/metadata_enrichment.py` owns the closed schema. malformed output rejects
the entire result; there is no repair generation. an accepted null is an absent
finding. unknown scalars preserve stored facts. all-null output
is `no_findings`, not success. partial findings and unchanged non-null confirmation
are successful research.

contributors are complete ordered observations of specified roles, not one
authors list. admitted handles preserve person identity across credited-name
changes; unbound names use the contributor owner's exact resolver. observed
spellings remain nonresolving aliases. duplicate identity within one role rejects
the result. an explicit empty role slice may clear that role; unresolved roles
remain untouched. the existing manual-author pin withholds differing automatic
author proposals, and the outcome reports that fact. no new manual field pins.

## research input and capability

metadata policy selects codex personal, `gpt-6-luna`, `xhigh`: 300 seconds and
32,768 utf-8 input bytes. the generation owner runs that selection or fails
visibly. no model substitution. stock 0.160 has no native hard context/output
token-cap field, so no token budget is recorded for it.

input includes current metadata, complete ordered credits/handles, source and
provider identifiers, media reference and up to 1,000 normalized opening words.
`metadata_enrichment_max_content_words` configures that allocation. raw reads are
bounded to 64,000 characters total; source order is plain text, canonical
fragments, podcast notes, then description. all serialized content fits the
utf-8 budget. descriptive hints are
clamped, then the excerpt shrinks to fit. identifiers, dates and credit rosters
are never silently truncated. oversized fixed context fails before dispatch.

the prompt requests `nexus.document.search`, `nexus.resource.read`, `web.search`
and `web.read`; public queries use identifying strings, not private passages.
source text is evidence, never instructions. the `MetadataResearch` plan
permits exactly those four tools; local reads use the admitted media scope.
`CodexCallbacks` executes that plan through the shared generation owner.
required search bindings need configured brave and embedding credentials;
absent local configuration fails the operation `model_unavailable` before submission.
see [llms.md](llms.md). metadata owns no provider adapter or
second context builder. exact model/effort and successful search/read require a
real isolated live receipt; controlled responses qualify domain behavior only.

## operation and publication

one `enrich_metadata` job freezes `purpose=bibliography|title`; title jobs also freeze
the published x source's successful `source_attempt_id`. every attempt builds its
input, generates once and publishes. the purpose's decoder (`accept_findings`: the one
`MetadataFindings` model, and only handles the input offered; `accept_x_title` for a
title) accepts the output or fails the generation `invalid_output`; the queue stores the
settled outcome as the job's result.

publication starts from a fresh session, locks media before the exact job claim,
and rechecks authorization, eligibility and the frozen source/bibliographic
fingerprint. document publication generation and transcript content revision
fence source replacement; index lifecycle never changes research identity.
publication commits changed facts, collection invalidations, successful timestamp
and the queue's terminal outcome/reactions together. it performs
no network call or nested transaction. contributor identity validation precedes
all writes. stale context, lost claim or revoked access cannot publish.

successful timestamps use database time, strictly later than the previous stamp;
the outcome uses the same instant. accepted unchanged values do not replace
identical credit rows or republish the reader title.

accepted findings settle `succeeded`. no findings, invalid output and terminal
research/domain failures return `TerminalJobFailure` and settle `dead` without
retrying paid research; a generation that never reached codex (host or
configuration unavailable) takes the job's one immediate retry, then settles a
terminal `model_unavailable`. a worker that dies mid-research reruns the whole operation
from scratch on the job's retry. metadata failures never
write source-processing error fields. successful and dead metadata jobs are
retained indefinitely so pruning cannot revive an older failure as latest.

## x titles

native x web articles use `media_title`: the same generation owner, `gpt-6-luna`,
`low`, strict `{title:string|null}`, no tools, 120 seconds and 256 kib utf-8 input.
`services/x_source.py` owns the current normalized snapshot and immediate source
label. the title input retains complete captured primary/direct context, attribution,
supplied alt text and coverage; it excludes image urls and generated child labels.
oversized complete input fails before dispatch; there is no prefix summary or model
substitution. [imports](imports.md) owns acquisition and source replacement.

preserve the primary author's language, stance, negation, uncertainty and quantities.
one usable primary language hint guides naming; primary prose overrides it, and
quoted/reply language never selects it. absent/conflicting hints imply no default.
quoted claims are context, never assumed endorsement. absent context and undescribed
images do not supply a subject. source instructions are untrusted evidence.
labels preserve actor, speaker and listener roles as well as names; any possessive
for reported speech identifies the speaker, with recipient/work relations distinct.
accepted
generated labels are trimmed, nonblank, one line and at most 120 unicode code points;
a standalone literal `null` string is invalid. actual json null successfully
restores the source excerpt/author label; it creates no attention
or review obligation. generated/source-label completions write only title and the
successful stamp. explicit rerun may restore an excerpt over an earlier model title.

missing snapshots block manual admission with `source_context_missing` and ordinary
source refresh. actual source publication admits one title job even with older jobs
unfinished; manual admission retains its active-work barrier. evidence version is the
snapshot's attempt, not a pending refresh attempt. replaced evidence rejects before
generation; publication rechecks source, current title, access and exact queue claim.
both generated and source-label output use these fences. title changes preserve
reader content generation, saved positions and selection.

every operation/retry dto carries purpose, including pre-dispatch and historical
entries. title completion has `changed_fields=[]|[title]` and
`disposition=generated|source_label`; bibliography retains its fields/no-findings
review. history reports that run's disposition, never current-title provenance.

## api and observation

`GET /media/{id}` owns the generated `Data[MediaOut]` contract: the keys the web reads,
the viewer's `consumption {state, progress}` and four capabilities (`can_read`,
`can_highlight`, `can_quote`, `can_retry`). the pane loader and metadata overlay share
one media-detail ingress (`mediaDetailFromResponse`): wire facts keep their values, the
player descriptor is renamed and chapter presentation is owned there as described in the
[reader module](reader-implementation.md); requested-media identity stays checked until
the pane drops it ([leftovers](../issues/media-pane-contract-leftovers.md)).

the displayed `processing_status` (summaries, media facts, detail and the processing frame
alike) is the stored status, except `suspended` while the latest source attempt is
repairable (in flight, its exact job dead) and no publication is readable
(`capabilities.publication_readable`: a ready reader publication, a pdf's file too). the
rule has no source branch: a readable article, x or not, reads `ready_for_reading` and keeps
Download while the menu offers its source remedy (`RepairSource`); an unreadable one reads
`suspended`.

- `/stream/media/{id}/events` emits the processing frame (status, failure code,
  retrieval status and reason, capabilities, transcript state and coverage) and ends
  (`done`) once nothing it shows is in flight: source work (an unsettled latest attempt
  that is not repairable, also while a refresh keeps an x article readable), a requested
  transcript, or a readable media's index whose job is not dead. an episode or video waiting on a
  transcript nobody requested answers one frame. the pane opens it when it first shows
  the media processing and again on each in-tab Imports invalidation: an Imports action,
  an add or upload, a transcript request (menus, a podcast's batch). so a transcript
  requested away from the pane still reaches it. each invalidation costs every mounted
  media pane one short processing read and, when that ends, one metadata read.

- `POST /media/{id}/metadata-enrichment`: creator-only admission; body
  `{expected_job_id: UUID | null}` (any other key is 400); 202 returns
  `{media_id, job_id, last_enriched_at}` in the data envelope. retry rule: an
  `expected_job_id` older than the latest job (or null while one exists) answers
  202 with the latest job, so a resend after a lost answer finds the run it
  started (as does another tab's click: both asked for research after what they
  saw). the latest answers only a request of its own purpose: an
  `expected_job_id` that is no job of this media, or a latest job of another
  purpose than the media's (an x article's bibliography run from before 0278), is
  409 `E_RESOURCE_CONFLICT`; the latest with unfinished work, an ineligible media,
  a title without its x source context (`source_context_missing`) or a non-creator
  is 409 `E_RETRY_NOT_ALLOWED` (403 for a non-creator first).
- `GET /media/{id}` includes `metadata_enrichment`: latest operation, precise
  retry permission, `last_enriched_at`, unfinished count and oldest unfinished
  operation. latest and oldest use `(created_at, id)`; a newer terminal result
  does not hide older live work.
- `POST /media/{media_id}/metadata-enrichment/{job_id}/review`: any current
  reader may mark that exact no-findings result reviewed for themselves; no
  body; 204. retry rule: an existing review stands (204, one row). review never
  changes the immutable outcome or bibliography. an inaccessible media is 404
  `E_MEDIA_NOT_FOUND`; a job that is not this media's metadata job is 404
  `E_NOT_FOUND` ("Metadata result not found"); another result is 409
  `E_RESOURCE_CONFLICT`.
- `/stream/media/{id}/metadata/events` emits the same typed view, authorizes each
  snapshot and ends (`done`) once `unfinished_count` is 0: an idle media answers
  one frame.

admission locks the media row only (never job rows: they are read through
`ix_metadata_jobs_media_created`); the lock serializes it with automatic enqueues.
no `client_mutation_id` and no replay ledger. successful source publication
commits its automatic metadata obligation in the same transaction. jobs are not
coalesced with stale work. every enqueue locks the media and stamps a strictly
ordered database creation time. successful playable video ingestion requests
research even without a provider snippet.

review locks the media, reauthorizes and inserts at most one row per (viewer,
job). removing media from one viewer clears only their reviews; physical teardown
clears all reviews while retaining jobs. operator deletion of a user or retained
job must remove dependent reviews first.

imports exposes metadata independently of source/search. its latest failure or
unreviewed no-findings result needs attention; any unfinished job keeps observation
alive and blocks fresh research. completed, partial and unchanged findings are
success. “mark reviewed” removes this result from needs attention for this viewer;
it stays in history and does not dismiss a newer result. each retained job supplies
one history entry, with its own latest generation, and review decorates that entry.
no-findings carries no failure code. safe metadata reasons never expose raw errors.

rss ingestion stores one nullable `rss_metadata_fingerprint` on its episode row.
new/changed normalized bibliography enqueues fresh research, including supplied
authors; identical feed replay preserves model corrections and creates no job.
old rows initialize from the first actual feed observation and may enqueue once.
diagnostic alias promotion remains independent: it spends no research and does
not restore feed bibliography. promotion during a turn may invalidate its frozen
input and require a deliberate rerun. chapters/transcript source mechanics retain
their existing owners.

media detail and the resource actions read share the same projection. detail
and each stream snapshot use repeatable read. existing `media_events`
notifications announce semantic job changes and committed reviews; heartbeats do
not. client admission and review receipts also invalidate imports so an idle
workspace wakes. the successful timestamp independently
invalidates facts when an older job publishes behind a newer latest job.

one view per media id per tab (`lib/media/mediaMetadataOperations.ts`) serves
the media pane and the `metadata…` overlay; imports renders its rows from its own
read. no collection-row subscriptions or browser polling. the tab follows a
media's stream while research can change it: on a mount (one short read when
idle), an admission (answered or lost: a lost answer may hide a landed run), a review, a
reconnect, and when the media's processing stream settles (a successful import
may have started research). a followed run is followed to its end even after its
pane closes, so lists still learn its title. an automatic run that starts while a
settled pane stays visible shows on the next mount, visibility change or overlay
open. bibliographic rereads preserve reader locator, selection and playback. a
frame whose stamp moved past the tab's known stamp publishes `Metadata`
(architecture §8.12) when its run changed a summary field (title, contributors,
first publication) or its fields are unknown; the admission's
`last_enriched_at` seeds the known stamp, so a run that lands before the first
frame still counts. unchanged success refreshes activity only. row menus use
their inspected action expectation.

each successful stamp rereads media and reloads the reader through its source port.
title-job admission also rereads: source publication and its new naming obligation
commit together, so mounted content updates even if generation later fails. a
same-content-identity response replaces only the current ready document's title;
units, structure, viewport, surface dom, selection and exploration origin remain.
changed content uses the ordinary reload, then reads its remapped cursor. the first
open keeps parallel source/cursor reads; a metadata-only pdf reload keeps learned
page count and viewer state. each title admission costs one detail read, including
manual admission. there is no additional subscription or poller.

the metadata overlay remains available for readable, pending and failed media.
it reads the media through the shared server-state hook (`useServerValue`, keyed
by media id, refetched on each new enrichment stamp or latest title-job id), so reopening it shows the
last values at once while it rereads. it separates reading status from research,
preserves existing facts during reread, and shows safe outcomes/model activity
(`selection`: the generation's route, model, or a provider route's `model_ref`,
and reasoning) without prompts or tracebacks.
live-disconnected and detail-reread failures have distinct reconnect/reread
actions. neither action starts new research.

the publication description displays `Media.description`; retained podcast
notes remain in their listening/source view and never replace this bibliographic
field.

the same detail response exposes stored `provider`, `provider_id`, `requested_url`
and `canonical_url` as required nullable fields. the overlay's source group shows the
exact provider identity and distinct stored urls alongside `canonical_source_url`;
it reconstructs no identifier or url and adds no reads. an absent provider says
`not recorded`; absent provider ids/urls are omitted. identical requested and
canonical urls distinct from the source url share one descriptive label.

## hard cutover and source repair

`0278` adds current x snapshots and tags every settled old metadata payload/typed
outcome `purpose=bibliography`, including old x research. raw dead-job result bytes,
ids, reviews, replay receipts and generation evidence remain. unfinished metadata,
open media-enrichment generations and active x source work refuse migration.
malformed typed outcomes and untyped succeeded jobs refuse it too. deploy api,
worker and web together through the existing release controller/verified backup.
no runtime legacy decoder remains. `nexus.ops.refresh_x_sources` freezes existing
x targets and records ordinary refresh/title receipts; unavailable
saved copies stay readable. see [the implementation plan](../x-import-titles-plan.md).

`0256` requires stopped writers and the verified release backup. unresolved
metadata jobs or generations block migration. settled legacy metadata jobs are
archived in that backup and removed from the live projection; existing facts,
successful stamps and generation evidence remain. only legacy metadata source
errors are cleared. deploy api, worker and web together; rollback restores the
verified backup, never an old decoder over new memos.

the sole suffix is `0252` → resource `0253` → atlas `0254` → native `0255` →
metadata `0256` → effects `0257` → local vault history `0258`. undeployed
metadata migration identifiers are renamed/reparented; disposable databases are
rebuilt, never stamped or aliased into this chain. historical receipts retain
their actual revisions.
combined verification must preserve historical effect/principal evidence and
roll back the entire transaction if metadata's later guard rejects the upgrade.
qualified immutable pins and genuine exact-model four-tool research are
delivered. metadata's installed job and bibliographic acceptance are separate
from that capability proof. production release additionally requires the
historical uncertainty disposition and actual starting-revision effect/undo
restore proof in `docs/metadata-enrichment-plan.md` §9 at `407fcc735`.

`python/scripts/repair_epub_contributors.py` previews by default and applies only
explicitly requested source-observation repair. it uses retained originals,
bounded parsing, source/credit fences and existing identities. it changes neither
reader state nor research timestamps. ambiguous items remain reported. see
[epub.md](epub.md). the old publication-date backfill and metadata arm of
`/media/{id}/retry` are removed; ordinary metadata admission is the research path.
