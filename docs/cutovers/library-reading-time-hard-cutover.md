# Library Reading-Time Hard Cutover

**Status:** Implemented and locally verified · 2026-07-21 · ordered production
release pending
**Type:** Ordered hard cutover — database/backend first, web second; no legacy
field, runtime text scan, fallback estimate, compatibility decoder, feature
flag, cache, or dual path survives.

**Measured release proof:** On an isolated production clone with API/worker
disconnected, migration `0186` completed in 14.08s. Across 50 warmed
representative max-page runs, the stored-count batch measured 4.523ms median and
5.671ms p95; its plan projected fragment identity and the generated integer, not
source text. Same-clone Library GET p95 moved from 57.923ms to 98.676ms across
50 runs, an added 40.753ms. All three AC-S4 limits pass.

Governing standards: `docs/rules/{boundaries,cleanliness,simplicity,codebase,
database,frontend,testing,timing,tagged-unions,control-flow}.md`.

## Council verdict

Approved as revised. Code confirms that Library documents lack an attention-cost
signal. Timed media has duration/position substrate, but Library does not yet
surface an equivalent signal; this is a reading slice, not existing parity.

The original request-time counter is rejected: a local production-rehearsal
scan of 158 documents / about 26 MB took roughly 3–5 seconds. STORED source
counts reduce the corresponding integer aggregation probe to about 1.2ms and
remove recurring text scans without cache or writer synchronization.
The touched boundary also justifies deleting duplicate entry read state and
discarded mutation payloads, consolidating counters, and fixing verified
metadata contrast and duplicate accessible names.

The durable meta is enforceable even if “frontier” is not: honest approximation,
canonical ownership, capability gating, derived state, strict boundaries,
accessible presentation, and measured work.

## Product decision

Library list and gallery rows show backend-owned `≈ 8 min read` for eligible
web articles, EPUBs, and text-readable PDFs. In-progress web/EPUB rows show
`≈ 3 min left` when whole-document progression exists. PDF remains total-only
because retained PDF progression is page-local.

This is an attention-fit affordance, not an analytics claim. Approximation is
communicated with `≈`, coarse rounding, and absence when the required source or
capability is absent. Open questions: none.

## Goals and scope

- Help the user choose what fits the attention available now.
- Provide honest, deterministic approximate total and remaining estimates.
- Keep list reads proportional to artifact rows, never document bytes; reuse
  canonical text, consumption, capabilities, presenters, signals, rows, and
  `Presence<T>` with one owner per policy.

In scope: every Library ordering/lane in list and gallery; total estimates for
ready web/EPUB/text-PDF media; remaining estimates for web/EPUB with retained
progression; generated source counts; one strict Library-entry field; one
presenter signal; and forced adjacent hard-cut cleanup.

Non-goals:

- no podcast/video duration UI in this cutover;
- no PDF locator/progression redesign;
- no sort, filter, setting, personalization, speed control, analytics, or LLM;
- no confidence score, source-version model, locale-specific tokenizer, or
  image/code/table weighting;
- no generic `timeCommitment`, new endpoint, request option, cache, or index;
- no cross-pane live countdown or synchronization.

## Target behavior

| Media/state | Canonical progression | First signal |
|---|---:|---|
| Ready web/EPUB, Unread or Finished | any latent value | `≈ N min read` |
| Ready web/EPUB, InProgress | present | `≈ N min left` |
| Ready web/EPUB, InProgress | absent | `≈ N min read` |
| Text-ready PDF, any state | ignored | `≈ N min read` |
| Unready/failed/zero-word document | any | no reading-time signal |
| Podcast, podcast episode, or video | any | no reading-time signal |

The estimate is `signals[0]`; publisher and published date follow. When the
estimate is absent, those existing signals retain their old order, so gallery
continues with publisher/date rather than becoming blank. Consumption
status/progress remains a separate affordance.

Use plain metadata text: no badge, pill, clock icon, tooltip, reserved column,
or bespoke reading-time style. Existing wrapping and tabular numerals remain.

## Estimation policy

`library_entries` owns the Library estimate policy:

```text
READING_WORDS_PER_MINUTE = 240

raw_total = word_count / READING_WORDS_PER_MINUTE
raw_remaining = word_count * (1 - progress_fraction)
                / READING_WORDS_PER_MINUTE

quantum(value) = 1 when value < 10
                 5 when 10 <= value < 60
                 15 when value >= 60

display_minutes(value) = max(
  1,
  quantum(value) * floor(value / quantum(value) + 0.5)
)
```

This is deterministic half-up rounding: nearest minute below 10, five minutes
below an hour, and fifteen minutes thereafter. Calculate remaining from raw word
count, never rounded total. The 240 WPM baseline deliberately rounds the 238 WPM
adult English non-fiction mean in Brysbaert's 2019 meta-analysis of 190 studies
and 18,573 participants ([source](https://biblio.ugent.be/publication/8647789)).

Rules:

- a word is one positive run of non-whitespace canonical text; punctuation is
  not linguistic analysis;
- explicit Unread/Finished state controls copy despite latent progression;
- remaining uses consumption's monotonic high-water `progress_fraction`, never
  a cursor or a new read;
- consumption alone owns its existing Finished threshold; estimate code does
  not reinterpret state;
- render `< 60` as `N min`; exact hours as `H hr`; otherwise `H hr M min`;
- labels are exactly `≈ {duration} read` and `≈ {duration} left`;
- invalid trusted values defect; do not clamp, coerce, or fabricate them.

Accepted 80/20 limitations:

- 240 WPM and whitespace words are English/space-delimited approximations.
  Metadata is not complete enough for a truthful locale gate; unsegmented
  languages can be materially undercounted. Add locale policy only when the
  actual corpus requires it.
- Character-based progression approximates remaining words; source replacement
  can weaken the correlation until a new source-version model exists.
- Remaining is a Library snapshot. Reload recomputes it; no live countdown is
  added.
- PDFs are total-only. Page/file size is never a fallback.

## Storage and metrics architecture

### Stored source metrics

Migration `0186` adds two internal PostgreSQL 15 STORED generated columns and a
storage-only downgrade that drops them. No downgrade restores an old runtime
path or alternate source.

```text
fragments.canonical_text_word_count INTEGER NOT NULL
  GENERATED ALWAYS AS (
    regexp_count(canonical_text, '[^[:space:]]+')
  ) STORED

media.plain_text_word_count INTEGER NULL
  GENERATED ALWAYS AS (
    regexp_count(plain_text, '[^[:space:]]+')
  ) STORED
```

In deployed PostgreSQL 15, [`regexp_count`](https://www.postgresql.org/docs/15/functions-string.html)
is immutable and strict: null PDF text
stays null and empty text yields zero. STORED columns compute existing rows and
remain synchronized with source-text inserts and updates
([PostgreSQL contract](https://www.postgresql.org/docs/15/ddl-generated-columns.html)).
This is a same-row storage derivative, not product policy. Python still owns
eligibility, WPM, rounding, and remaining. Existing generated-`tsvector` and
`(media_id, idx)` index primitives are reused; no trigger, check, manual
backfill, writer change, or count index is added.

### Metrics service contract

`media_document_metrics.py` is the sole media-level aggregate query owner and
exposes two semantic operations, without mode flags:

```text
load_media_word_counts(db, media_ids[0..200 distinct])
  -> dict[media_id, nonnegative word_count]

MediaSummaryMetrics
  word_count: nonnegative integer
  source_section_count: Presence<nonnegative integer>

load_media_summary_metrics(db, media_id)
  -> MediaSummaryMetrics
```

Contract:

- empty input returns `{}` without a query; deduplicate before enforcing 200;
  callers supply existing, authorized, text-ready IDs;
- web/EPUB sum `fragments.canonical_text_word_count`; PDF reads
  `media.plain_text_word_count`; `SUM(integer)` is deliberately decoded from
  PostgreSQL bigint to a bounded Python integer;
- summary behavior: PDF words + page count; web/EPUB words + section Absent
  (navigation owns headings); podcast/video words + fragment count.
  `media_read_map` adapts Presence to its retained nullable boundary;
- each accepted input returns a nonnegative value; missing/unsupported/negative
  defects. Library maps zero to outer Absent;
- one list batch touches only IDs, media kinds, generated integer columns, and
  fragment identity—never `canonical_text`, `plain_text`, retrieval chunks, or
  file bytes;
- shared PDF quote readiness checks `plain_text_word_count > 0`; list and detail
  capability hydration never detoast or scan PDF source text;
- `media_read_map` retains authorization/readiness/section semantics and its
  combined PDF/timed summary reads;
- source-local projections may read their own generated value: EPUB section
  reads return the stored fragment count and the Python
  `_compute_word_count` helper is deleted.

### Composition

```text
canonical text -> STORED count -> integer batch -> Library policy/DTO
  -> strict web boundary -> presentMedia -> list + gallery
```

`_hydrate_entries` composes the list projection in that order. It asserts that
consumption returned a non-null read state for every hydrated Library media ID.
It does not infer readiness from kind: only current `capabilities.can_quote`
eligible document media reaches the metrics batch.

## API and command contracts

### List DTO

The field belongs to `LibraryEntryOut`, not shared `MediaOut`:

```text
ReadingTimeEstimateOut (strict camel record; extra fields forbidden)
  totalMinutes: strict integer 1..2_147_483_647
  remainingMinutes: Presence<strict integer 1..2_147_483_647>

LibraryEntryOut
  readingTimeEstimate: Presence<ReadingTimeEstimateOut>  # required
```

No estimate is exactly `{ "readingTimeEstimate": { "kind": "Absent" } }`.
Outer Absent means no Library reading estimate; inner Absent means total-only.
The required outer field exists for media and podcast entries. No null,
omission, formatted string, word count, WPM, model metadata, or alternate
discriminator is public.

`GET /libraries/{id}/entries` serializes with aliases. This hard-cuts the new
field and the already-declared nested media alias to `playerDescriptor`, whose
entire descriptor subtree is camelCase. Snake aliases are forbidden.

### Dead command payload cut

Every current caller discards the bodies of these three commands. Hard-cut them:

| Command | Final success response |
|---|---:|
| `POST /libraries/{id}/media` | `204 No Content` |
| `POST /libraries/{id}/podcasts` | `204 No Content` |
| `PATCH /libraries/{id}/entries/reorder` | `204 No Content` |

Replace `LibraryFilingOutcome.entry` with an inserted-only filing result used by
agent Undo logic. Filing commands stop reselecting/hydrating the inserted entry;
reorder stops relisting the whole Library. No BFF compatibility code or
alternate status remains.

## Web boundary and state composition

`apps/web/src/lib/libraries/readingTime.ts` owns the internal types, the narrow
strict decoder, duration formatting, and signal copy. It reuses
`decodePresence`, `expectExactRecord`, and integer validators; it does not create
a one-consumer generic formatter.

Initial, resonance, and load-more entries share one decoder. It validates every
policy input: exact media-kind/status literals; non-null `read_state`; required
`progress_fraction` as null or finite `[0, 1]`; and boolean
`capabilities.can_quote`. It rejects missing/null/snake estimate fields,
malformed Presence, invalid integers, extra estimate keys, and:

- Present outer value on a non-media, non-document, unready, or non-quotable
  server snapshot;
- within a Present web/EPUB estimate, `remainingMinutes` is Present if and only
  if `read_state == "in_progress"` and progression is non-null; PDF remaining is
  always Absent;
- `remainingMinutes > totalMinutes`.

The decoded `Presence` survives through presentation. Library passes the
entry-owned estimate to `presentMedia` as a required explicit input; it is not
made optional and is not added to `MediaOut`.

Fetched cross-field validity and current UI validity are distinct. The presenter
uses the current effective local media state:

- show `left` only when current `read_state == in_progress` and decoded
  remaining is Present;
- current Unread/Finished shows total;
- current non-ready or `can_quote != true` suppresses the estimate;
- never mutate/clear/recalculate the decoded estimate in component state.

One local helper applies media-ID-scoped functional patches to both manual and
resonance arrays for consumption and processing/capability changes. Consumption
rollback restores only the target media's prior fields and only while that
operation token is still current; it never restores an array snapshot. A
concurrent load-more, unrelated row patch, or newer same-row action survives.

## Visual and accessibility contract

- Reading time is the first ordinary metadata signal in list and gallery.
- Change existing list/gallery metadata color from `--ink-faint` (measured
  3.62–4.27:1 on supported surfaces) to `--ink-muted`, which clears normal-text
  AA. Do not add a reading-time-only class or change global tokens.
- Collection thumbnails adjacent to the same visible title are decorative:
  rows/cards pass `alt=""`; `ResourceThumb` makes its icon branch `aria-hidden`
  when alt is empty instead of emitting an unnamed `role="img"`.
- The activation's accessible name contains the title once and the reading-time
  text once. Do not add redundant ARIA, an icon-only meaning, or a tooltip.
- The longest supported label wraps without horizontal overflow in compact list
  and the existing 168 px gallery-card case.

## Hard-cut cleanup

Delete:

- root `LibraryEntryOut.read_state` / `progress_fraction`, assignments,
  frontend copies, and stale ownership comments; nested Library `media` is the
  consumed owner and its `read_state` is required/non-null;
- runtime regex/split word counting in `media_read_map` and `epub_read`;
- `LibraryFilingOutcome.entry`, post-command row reads/hydration, and reorder
  relisting;
- any optional/null reading-time shape or compatibility parser introduced while
  implementing.

Retain `MediaOut` consumption, the authorized `load_media_document_summary`
boundary, playback `formatClock`, and existing collection primitives.

Update every current-state consumption/read-state claim in
`collection-surface-hard-cutover.md`; do not patch only its entry-field clause
while leaving obsolete session/table/owner statements nearby.
Refresh the superseded filing-outcome wording in
`default-library-virtualization-and-transient-state-pruning-hard-cutover.md`.

## Files

Create:

- `migrations/alembic/versions/0186_library_reading_time_word_counts.py`
- `python/nexus/services/media_document_metrics.py`
- `python/tests/test_media_document_metrics.py`
- `apps/web/src/lib/libraries/readingTime.ts`
- `apps/web/src/lib/libraries/readingTime.test.ts`

Modify:

- backend: `schemas/library.py`, `schemas/media.py` (stale comment),
  `services/library_entries.py`, `services/media_read_map.py`,
  `services/epub_read.py`, `services/pdf_readiness.py`,
  `services/agent_tools/writes.py`,
  `api/routes/libraries.py`;
- backend tests: `test_migrations.py`, `test_libraries.py`, `test_media.py`,
  `test_library_target_picker.py`, `test_media_deletion.py`,
  `test_media_libraries_endpoint.py`, `test_podcasts.py`, and
  `real_media/test_reingest_delete_permissions.py`;
- Library web: `LibraryPaneBody.tsx`, both adjacent LibraryPaneBody tests,
  `paneResourceLoaders.ts` and its test, `workspace/bootstrap.server.test.ts`;
- presentation: `collections/readState.ts`, `presenters/media.ts` and test,
  `ResourceThumb.tsx`, `CollectionRow.tsx`, `CollectionGalleryCard.tsx`,
  `CollectionView.test.tsx`, `ResourceRow.module.css`,
  `CollectionGalleryCard.module.css`, `lib/ui/contrast.test.ts`;
- docs: `docs/architecture.md`, `docs/modules/library.md`, all stale
  current-state passages in `docs/cutovers/collection-surface-hard-cutover.md`,
  and the filing-outcome claim in
  `default-library-virtualization-and-transient-state-pruning-hard-cutover.md`.

Verify without assumed edits: `python/tests/test_resource_graph_resolve.py` and
`python/tests/test_agent_writes.py`.
Delete files: none. Do not change `lib/display/format*`, BFF proxy routes,
generic row APIs, global tokens, or ingestion writers.

## Acceptance criteria

Storage/metrics:

- **AC-S1.** Migration covers existing/replaced text and exact
  zero/space/tab/newline/punctuation cases; null PDF text stays null and empty
  text yields zero.
- **AC-S2.** A 0–200-distinct-ID Library batch is at most one query over stored
  counts and identities; query text and plan do not read full-text columns or
  add an index. Shared PDF readiness also reads only its stored positive count.
- **AC-S3.** Web/EPUB totals sum canonical fragments; PDF uses current plain
  text; resource-summary and EPUB word counts remain behaviorally unchanged.
- **AC-S4.** On a production clone, migration lock/evaluation is at most 30s;
  warmed metrics-batch p95 is at most 50ms over at least 30 representative
  max-page runs; and Library GET added p95 is at most 100ms versus baseline.
  API/worker stay stopped during migration. Any miss blocks release and requires
  this design to be revised—never a runtime fallback.

Backend/API:

- **AC-B1.** Eligible positive-count documents return required Presence;
  unsupported/unready/zero returns outer Absent. Unread/Finished/PDF is
  total-only; in-progress web/EPUB with progression has remaining.
- **AC-B2.** Rounding matches every 1/5/15-minute boundary and remaining never
  exceeds total.
- **AC-B3.** List output is aliased; `readingTimeEstimate` and the entire
  `playerDescriptor` subtree are camelCase, with snake forms absent.
- **AC-B4.** Add-media, add-podcast, and reorder return 204 and perform no
  response hydration; agent filing Undo retains inserted/already-present truth.
- **AC-B5.** No migration-time or request-time count fallback, text scan, cache,
  retrieval-token sum, LLM call, or duplicate entry read-state projection exists.

Frontend/product:

- **AC-F1.** Initial, resonance, and load-more paths share one strict decoder;
  every required policy input and both directions of the remaining-time
  invariant are tested at that boundary.
- **AC-F2.** List/gallery use the same first signal/copy/format; publisher/date
  retain order when estimate is Absent, which renders no placeholder.
- **AC-F3.** Optimistic Finished/Unread switches immediately to total; scoped
  rollback restores `left` without losing concurrent load-more/unrelated
  updates; current unready/non-quotable state suppresses stale estimates in both
  manual and resonance arrays.
- **AC-F4.** Metadata passes 4.5:1 contrast, activation names contain title and
  estimate once, decorative thumbnails are silent, and narrow layouts do not
  overflow.
- **AC-F5.** No placeholder/client estimate, pill, tooltip, icon, CSS fork,
  generic formatter, or generic time-commitment abstraction exists.

## Verification and cutover

Use focused owner tests only:

- migration/generated-column and database-backed metrics tests;
- mixed-kind Library API, override/progress, alias, 204-command, PDF-readiness,
  resource-summary, and EPUB regressions;
- pure decode/round/format matrices;
- presenter plus Library initial/resonance/load-more, optimistic/rollback,
  accessibility, contrast, and narrow-width tests;
- path-scoped Ruff/format, ESLint, frontend typecheck, and `git diff --check`.

Persistent tests assert behavior and contracts, not source spelling. One-time
residue review may use `rg` for removed fields/formulas/aliases. Do not duplicate
the existing production negative gate for `reading_sessions`. No broad suite is
required when these owners are green.

Deployment order is mandatory because Vercel deploys `main` automatically while
Hetzner is manual, and the web decoder intentionally rejects the old backend.
Release as two ordered commits/deployments, not one combined push:

1. Push the migration/backend commit; the unchanged web may redeploy safely.
2. Hetzner deploy stops API/worker, applies migration `0186`, and starts the new
   backend/worker. Smoke `GET /libraries/{id}/entries` for Presence, aliases,
   mixed kinds, and list latency/query shape.
3. Push the web/docs commit; let Vercel deploy it, then smoke list/gallery and
   one optimistic state change.

No compatibility code exists between steps. If rollback is required, roll back
web first, then backend. The additive generated columns may remain until the
forward fix; no runtime fallback may read around them.

## Future timed-media equivalent

Podcast/video support is a separate cutover. It must start from authoritative
duration (`podcast_episodes.duration_seconds`, viewer-observed duration, or
provider video metadata), never transcript word count or last transcript
timestamp. It must decide whether remaining listening/viewing time reflects
playback speed and which monotonic position owns progress.

Only when a second modality ships should the council reconsider a typed
`timeCommitment` contract. If warranted, hard-cut the reading-only field rather
than append parallel aliases. Podcast-show rows continue to prefer unplayed
count over fabricated aggregate duration.
