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
32,768 utf-8 input bytes, a 64,000-token context budget and an 8,000-token output
reservation. the generation owner admits that selection or fails visibly.
no model substitution.
native execution and genuine tool qualification belong to the separate kernel
integration. stock 0.160 has no native hard context/output token-cap field;
the user accepted admission/reservation semantics on 2026-10-02. frozen budgets
and observed usage are not proof of enforced ceilings.

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
source text is evidence, never instructions. the frozen `MetadataResearch` grant
permits exactly those four tools; local reads use the admitted media scope.
`CodexCallbacks` executes that plan through the shared generation owner.
required search bindings need configured brave and embedding credentials;
absent local configuration yields typed unavailability before submission.
see [llms.md](llms.md). metadata owns no provider adapter or
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
bounded queue retry. terminal native quota failures settle failed; shell quota
parking is retired. unresolved submission blocks
fresh research until the generation owner settles it. metadata failures never
write source-processing error fields. successful and dead metadata jobs are
retained indefinitely so pruning cannot revive an older failure as latest.

`generation_has_local_recovery` authorizes only local settlement from the exact
original native seal or authoritative non-submission evidence. metadata reuses
the original frozen spec, intent and handles before mutable domain reads;
execution recovers before provider/catalog calls. publication still checks
current source, credits, access and claim. a parent terminal or process stop
alone never unlocks research. completed-journal publication replay remains
metadata-owned.

## api and observation

`GET /media/{id}` owns the generated `Data[MediaOut]` contract, including required
nullable fields and nested player aliases. it keeps the existing default
response serialization. the pane loader and metadata overlay share one
media-detail ingress: typed wire facts retain their values, duration minutes
become their existing domain wrappers, and media identity/date/player identity
receive local brands. requested-media identity stays checked. chapter
presentation remains owned by that ingress as described in the
[reader module](reader-implementation.md).

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

`0256` requires stopped writers and the verified release backup. unresolved
metadata jobs or generations block migration. settled legacy metadata jobs are
archived in that backup and removed from the live projection; existing facts,
successful stamps and generation evidence remain. only legacy metadata source
errors are cleared. deploy api, worker and web together; rollback restores the
verified backup, never an old decoder over new memos.

the sole suffix is `0252` → resource `0253` → atlas `0254` → native `0255` →
metadata `0256` → effects `0257`. undeployed metadata migration identifiers are
renamed/reparented; disposable databases are rebuilt, never stamped or aliased
into this chain. historical receipts retain their actual revisions.
combined verification must preserve historical effect/principal evidence and
roll back the entire transaction if metadata's later guard rejects the upgrade.
qualified immutable pins and genuine exact-model four-tool research are
delivered. metadata's installed job and bibliographic acceptance are separate
from that capability proof. production release additionally requires the
historical uncertainty disposition and actual starting-revision effect/undo
restore proof in [the plan](../metadata-enrichment-plan.md#9-hard-cutover-and-verification).

`python/scripts/repair_epub_contributors.py` previews by default and applies only
explicitly requested source-observation repair. it uses retained originals,
bounded parsing, source/credit fences and existing identities. it changes neither
reader state nor research timestamps. ambiguous items remain reported. see
[epub.md](epub.md). the old publication-date backfill and metadata arm of
`/media/{id}/retry` are removed; ordinary metadata admission is the research path.
