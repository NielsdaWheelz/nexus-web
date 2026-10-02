# media metadata

`services/metadata_enrichment.py` owns bibliographic meaning, bounded input and
strict generated-output acceptance. `tasks/enrich_metadata.py` composes it with
the contributor owner and generation service. `services/metadata_operations.py`
projects the existing jobs; it stores no shadow activity state. the implementation
contract is [metadata-enrichment-plan.md](../metadata-enrichment-plan.md).

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

generated json has exactly eight required nullable fields: title, contributors,
original date, edition date, edition isbn, publisher, language and description.
`schemas/metadata_enrichment.py` owns the closed schema. malformed output rejects
the entire result; there is no repair generation. accepted nulls become
`Presence<T>` immediately. unknown scalars preserve stored facts. all-null output
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

metadata policy selects codex personal, `gpt-6-luna`, `xhigh`: 300 seconds,
32,768 utf-8 input bytes, 64,000 context tokens and 8,000 output tokens. the
generation owner admits that selection or fails visibly. no model substitution.
native execution and genuine tool qualification belong to the separate kernel
integration; a frozen budget is not proof of native enforcement.

input includes current metadata, complete ordered credits/handles, source and
provider identifiers, media reference and up to 1,000 normalized opening words.
`metadata_enrichment_max_content_words` configures that allocation. raw reads are
bounded to 64,000 characters total; source order remains plain text, ready indexed
chunks, fragments, podcast notes, then description. all serialized content,
including frozen admission facts, fits the utf-8 budget. descriptive hints are
clamped, then the excerpt shrinks to fit. identifiers, dates and credit rosters
are never silently truncated. oversized fixed context fails before dispatch.

the prompt requests `nexus.document.search`, `nexus.resource.read`, `web.search`
and `web.read`; public queries use identifying strings, not private passages.
source text is evidence, never instructions. the generation owner controls the
actual tool grant: the current codex shell grant is account-wide, and this prompt
does not narrow it. see [llms.md](llms.md). metadata owns no provider adapter or
second context builder. exact model/effort and successful search/read require a
real live receipt before release; controlled responses qualify domain behavior
only.

## operation and publication

one `enrich_metadata` job is one operation. its stable `codex/metadata` step
stores accepted metadata and publication outcome in the existing memo. provider
terminal truth, domain acceptance and queue settlement are separate facts.

publication locks media before the exact job claim, rechecks authorization,
eligibility and frozen source/credit context, then commits changed facts,
collection invalidations, successful timestamp and outcome together. it performs
no network call or nested transaction. contributor identity validation precedes
all writes. stale context, lost claim or revoked access cannot publish.

successful timestamps use database time, strictly later than the previous stamp;
the outcome uses the same instant. accepted unchanged values do not replace
identical credit rows or republish the reader title. completed memo replay reuses
the stored outcome without merging, restamping or buying another generation.

accepted findings settle `succeeded`. no findings, invalid output and terminal
research/domain failures return `TerminalJobFailure` and settle `dead` without
retrying paid research. known retryable pre-submission failures use the ordinary
bounded queue retry; waits use existing rescheduling. unresolved submission blocks
fresh research until the generation owner settles it. metadata failures never
write source-processing error fields. successful and dead metadata jobs are
retained indefinitely so pruning cannot revive an older failure as latest.

the native candidate remains unqualified. its shared recovery seam must read the
exact provider-sealed model-turn terminal locally before provider/catalog calls;
metadata will call it from the early uncertainty guard when delivered. a parent
terminal or process stop alone never unlocks research. current completed-journal
publication replay is already metadata-owned.

## api and observation

- `POST /media/{id}/metadata-enrichment`: creator-only, replayable admission;
  body `{client_mutation_id, expected_job_id: Presence<UUID>}`; 202 returns
  `{media_id, job_id}` in the existing data envelope.
- `GET /media/{id}` includes `metadata_enrichment`: latest operation, precise
  retry permission and `last_enriched_at`.
- `/stream/media/{id}/metadata/events` emits the same typed view, authorizes each
  snapshot and stays open after terminal/absent activity to discover later jobs.

replay follows authorization and precedes fresh-admission barriers. a fresh
request must name the latest observed job; any pending/running/scheduled retry or
uncertain retained step blocks it. a lost response resends the original intent.
automatic source-triggered jobs retain their existing timing and use the same
result contract; they are not coalesced with stale work. every enqueue locks the
media and stamps a strictly ordered database creation time.

rss ingestion stores one nullable `rss_metadata_fingerprint` on its episode row.
new/changed normalized bibliography enqueues fresh research, including supplied
authors; identical feed replay preserves model corrections and creates no job.
old rows initialize from the first actual feed observation and may enqueue once.
diagnostic alias promotion remains independent: it spends no research and does
not restore feed bibliography. promotion during a turn may invalidate its frozen
input and require a deliberate rerun. chapters/transcript source mechanics retain
their existing owners.

detail/action snapshots batch the same projection. detail and each stream
snapshot use repeatable read. existing `media_events` notifications announce
semantic job changes; heartbeats do not. the successful timestamp independently
invalidates facts when an older job publishes behind a newer latest job.

one shared browser observer serves visible details and the `metadata…` overlay
for each media id. no collection-row subscriptions or browser polling. reconnect
reconciles missed work; closing details detaches observation without cancelling
research. bibliographic rereads preserve reader locator, selection and playback.
changed research refreshes existing collection revision owners; unchanged success
refreshes activity only. row menus use their inspected action expectation.

each successful stamp checks the text reader's authoritative navigation version;
the same version needs no content reread. a different version verifies current
navigation/content/navigation and exact byte/anchor equality through the reader
owner before advancing attestation while keeping mounted coordinates. a missed
title change back to the original spelling is still detected. changed content
uses the existing composed reload; pdf metadata does not reopen its viewer.
this costs one small navigation read per successful text-reader enrichment.

the metadata overlay remains available for readable, pending and failed media.
it separates reading status from research, preserves existing facts during
reread, and shows safe outcomes/model activity without prompts or tracebacks.
live-disconnected and detail-reread failures have distinct reconnect/reread
actions. neither action starts new research.

the publication description displays `Media.description`; retained podcast
notes remain in their listening/source view and never replace this bibliographic
field.

the same detail response exposes stored `provider`, `provider_id`, `requested_url`
and `canonical_url` as required presences. the overlay's source group shows the
exact provider identity and distinct stored urls alongside `canonical_source_url`;
it reconstructs no identifier or url and adds no reads. an absent provider says
`not recorded`; absent provider ids/urls are omitted. identical requested and
canonical urls distinct from the source url share one descriptive label.

## hard cutover and source repair

`0253` requires stopped writers and the verified release backup. unresolved
metadata jobs or generations block migration. settled legacy metadata jobs are
archived in that backup and removed from the live projection; existing facts,
successful stamps and generation evidence remain. only legacy metadata source
errors are cleared. deploy api, worker and web together; rollback restores the
verified backup, never an old decoder over new memos.

the standalone native candidate's `0254` also descends from `0252`; combined
integration must establish one linear head with the kernel owner. immutable
qualified pins, installed provider-sealed recovery and actual exact-model web
research are still release prerequisites. `CodexCallbacks` / `MetadataResearch`
qualification does not follow from the current shell-route or controlled peers.

`python/scripts/repair_epub_contributors.py` previews by default and applies only
explicitly requested source-observation repair. it uses retained originals,
bounded parsing, source/credit fences and existing identities. it changes neither
reader state nor research timestamps. ambiguous items remain reported. see
[epub.md](epub.md). the old publication-date backfill and metadata arm of
`/media/{id}/retry` are removed; ordinary metadata admission is the research path.
