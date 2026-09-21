# quick reads and remaining-time ordering

status: implemented; verification recorded in [quick-reads-verification.md](quick-reads-verification.md)
origin: 2026-09-21 owner decisions and adversarial backend/frontend review
implementation baseline: `2b4a6ace67`; branch `feat/quick-reads`

## goal and scope

- section order: existing queue, **quick reads**, **at hand**. quick reads uses
  the existing comfortable list: at most five distinct media with under ten
  minutes remaining. fewer matches means fewer rows; empty says "no quick reads".
- fixed count and duration. no time/library controls, see-all link, pagination,
  dedicated add button, dismiss action, or settings. retain standard row menus
  and error recovery. opening navigates without enqueueing.
- quick reads includes already-queued media and works at full queue capacity.
  overlap with other sections is permitted.
- library **contents** gain remaining-time ordering in both directions. authored
  positions, library-index order, other sort modes and filters remain unchanged.
- remove relation explanations and inline related-item expansion from media
  lists. human/ai graph connections remain available inside the opened resource.

non-goals: new relevance policy, ai/model calls, calibration, sections/excerpts,
audio/video duration, pdf progress estimation, completion-policy changes,
notifications, background work, recommendation storage, new infrastructure.

## duration contract

use existing positive canonical word counts and the existing 240 words/minute
policy. estimates cover readable/quotable `web_article`, `epub`, and `pdf` media;
reuse current capability and pdf quote-readiness predicates before selection.
other kinds, unavailable text and nonpositive counts have no estimate.

| saved reader state | remaining duration |
| --- | --- |
| no cursor row or explicit empty cursor | total duration; resume starts at the beginning |
| positioned web/epub with whole-document progression `p` | total × `(1 - p)` |
| positioned web/epub without whole-document progression | unknown |
| positioned pdf | unknown; its page-local position is not whole-document progression |

- `total_seconds = word_count / 4.0`; compute raw seconds as SQL `float8` once
  in the shared projection. estimate from the current durable cursor, never
  `max_total_progression`. moving backward increases remaining time.
- calculate independently of consumption state. finished status does not invent
  zero remaining; quick reads separately excludes canonically finished media.
- raw zero is valid. quick eligibility is strictly **`0 < remaining_seconds < 600`**.
  unknown is excluded. neither rounded labels nor a long work's total duration
  determine this predicate.
- retain current half-up 1/5/15-minute display rounding. positive durations display
  at least one minute; exact zero displays zero. never use display values as sort
  keys. an eligible estimate just below ten minutes may display "≈10 min".
- reading rows show known remaining time, without a percentage. retain percentage
  when time is unknown. unread rows with only total time label it "total".
  `SetUnread` preserves the cursor: unread does not imply a full-duration estimate.
  audio formatting and canonical consumption progress/completion remain unchanged.

## owners and composition

reuse authenticated, read-only, repeatable-read boundaries and owner query ports.

| owner | change / contract |
| --- | --- |
| `services/media_document_metrics.py` | expose one stored word-count relation; existing batch reads consume it. no request-time text scanning. |
| `services/consumption/reader_cursor.py` | expose viewer-scoped current-position facts: media id, empty/positioned distinction, nullable whole-document progression. retain sole ownership of `reader_media_state`. |
| `services/capabilities.py`, `pdf_readiness.py` | expose queryable document readiness equivalent to current `can_quote`; extract shared pdf predicate in its owner, without inventing a second readiness policy. keep this read port independent of media mutation/indexing imports. |
| new `services/reading_time.py` | compose those ports; own raw total/remaining seconds and display conversion. provide a query relation and a batch projection over that same relation. |
| `services/library_entry_listing.py` | consume shared estimates; own remaining-time ordering, hydration and pagination. delete its local estimate calculation/constants. |
| `services/resonance/service.py` | own quick-read candidate eligibility and composition; reuse existing evidence, ranking and hydration. |
| frontend presenters / shared formatter | render factual fields using existing collection primitives; no duration calculation or client-side ranking. |

selection: authorized documents → readiness/duration/unfinished predicates →
existing lectern evidence → existing ranking/diversity → five → hydration.
eligibility precedes **every** acquisition cap, including semantic candidates.
never filter the ten returned at-hand rows. give the existing composer its two
real limits (five and ten); no general recommendation framework.

retain resonance's current qualification rules and stored semantic evidence.
there is no fallback family: old short works without qualifying evidence may not
appear. at hand retains its existing queue-membership/capacity rules. quick reads
uses shared visible facts without those two exclusions.

## wire and query contracts

reuse strict camelCase models, exact client decoders, `Presence`, publication-date
types, `ConsumptionOut`, media targets and standard error envelopes.

```text
ReadingTimeEstimateOut = {
  totalMinutes: integer >= 1,
  remainingMinutes: Presence<integer >= 0>
}
SlateItemOut = {
  target: existing SlateTargetOut,
  publicationDate: Presence<existing publication-date type>,
  consumption: Presence<ConsumptionOut>,
  readingTimeEstimate: Presence<ReadingTimeEstimateOut>
}
GET /lectern/quick-reads -> { data: { items: SlateItemOut[0..5] } }
GET /lectern/slate -> { data: { items: SlateItemOut[0..10] } }
GET /libraries/{id}/slate -> { data: { items: SlateItemOut[0..10] } }
GET /libraries/{id}/entries?sort=remaining&direction=asc|desc
```

- quick items require document media, consumption and positive known remainder.
  boundary validation owns shape/kind/count; selection owns the raw cutoff.
  media consumption is present; podcast-container consumption/estimates are absent.
  hydrate facts from their owners. reasons/anchors stay internal to ranking.
- publication dates: media use `original_published_date`; podcast episodes use the
  episode owner's `published_at` converted to a utc calendar date; podcast
  containers have none. extend compact media hydration in `services/media.py`
  using existing episode publication ports; do not put timestamps in date fields.
- quick reads accepts no query parameters; reuse the web proxy and read/error
  boundaries. no mutations.
- move `ReadingTimeEstimateOut` from `schemas/library.py` to
  `schemas/reading_time.py`; move its reusable frontend type/decoder to
  `lib/media/readingTime.ts`. keep entry-specific decoding in its library owner.
  update imports directly; no compatibility re-exports.
- reuse the existing `decodeConsumption` from `lib/lectern/contract.ts`, making
  that decoder public instead of copying it. add a nonnegative remaining-minute
  type; retain positive total-minute types. give `CollectionActivity.Unread` a
  `remainingMinutes` presence field too, since unread can retain a cursor.
  populate it through `readActivity`; never substitute remainder into a total field.
- remaining order is `(missing ASC, raw_seconds direction, title ASC, existing
  target identity tie-breakers)`. unknowns stay last in both directions. other
  library projections/type filters still apply; this sort does not hide finished
  media. apply ordering to the full server query before keyset/limit.
- add only `FloatOrNull` to the existing keyset codec; require finite numeric
  round-tripping and SQL `float8` values. preserve exact view/plan cursor binding.
  reuse `LibraryEntries` revisions: accepted cursor/reset writes already bump
  them. confirm content/readiness publications also invalidate affected ordering;
  continuation after a relevant change uses existing `409 E_COLLECTION_CHANGED`.

## frontend behavior

`QuickReadsSection` uses `PaneSection`, `CollectionView`, the shared slate
presenter and `useResource`; do not copy `useReadingSlate`'s mutation lifecycle.

fetch on first active mount, pane reactivation, and existing consumption/placement
revision changes while active. reuse abort/retry/error handling. no polling or new
invalidation bus. preserve section position while loading; distinguish error/empty.

fetch independently of at hand, preserving its seed. quick reads starts client-side;
no composed-seed/cache machinery. extend library URL codecs/selectors with
"remaining time — shortest first / longest first". extend the existing consumption
snapshot with `durationRevision`, advanced only after accepted cursor saves and
`ResetProgress`. all library views compare that captured revision; remaining order
also follows the existing general consumption revision, as do filtered views.
reuse existing reconciliation and preserve committed-view and pane-return handling.
when a focused quick-read row disappears, restore focus to its section only if
focus was stranded; never steal focus from another control or an inactive pane.

## hard cutover and deletion

ship backend/web together; accept only the new slate shape. remove reason
serialization/decoders, `presentSlateReason`, and unused explanation-only label
hydration. retain evidence used by qualification, ranking or diversity.

remove `CollectionRow` peer disclosure state/actions and `CollectionRowView.relatedMediaId`
from every presenter. delete `ConnectionRail.tsx`, its css, and `useRelatedMedia.ts`.
their sole endpoint `/media/{id}/related`, `RelatedMediaOut`, and
`resonance.service.related_media` retire together. preserve the separate resource
graph / inspector connection capability and shared semantic primitives still used
by resonance. no hidden legacy controls, alternate response decoders, or endpoint
aliases. no database migration or stored recommendation state is required.

## implementation boundaries and review gates

paths are relative to `python/nexus/` or `apps/web/src/`. file ownership is exclusive.

| track | exclusive files / deliverable | adversarial gate |
| --- | --- | --- |
| a: duration and library backend | python `services/{reading_time,media_document_metrics,media,capabilities,pdf_readiness,library_entry_listing,keyset_cursor}.py`, `services/consumption/reader_cursor.py`, `schemas/{reading_time,library}.py`; lifecycle revision fixes only if needed | no high-water estimate, duplicated formula/readiness, unknown→zero coercion, or display-minute sort; cursor round-trip preserves order |
| b: resonance and transport backend | python `services/resonance/`, `schemas/{resonance,resource_graph}.py`, `api/routes/{lectern,media}.py` | eligibility precedes every cap; five limit; no queue gate, new relevance policy, reason payload, or retired related endpoint |
| c: shared frontend contracts and rows | web `lib/{media/readingTime,libraries/readingTime,libraries/entryListItem,lectern/contract,resonance/contract,resonance/presentSlateItem,consumption/activityFacts}.ts`, `lib/collections/`, `components/collections/{CollectionRow,collectionRowFormatting,ConnectionRail}*`, `lib/resonance/useRelatedMedia.ts` | new shape only; zero remains representable; no relationship display; retained metadata and resource actions still work |
| d: feature composition and library controls | web `components/collections/QuickReadsSection.tsx`, `lib/resonance/client.ts`, `lib/libraries/libraryView.ts`, `lib/consumption/projectionRevision.ts`, `lib/reader/useReaderProgress.ts`, `lib/lectern/LecternProvider.tsx`, `app/(authenticated)/{lectern/LecternPaneBody,libraries/[id]/LibraryPaneBody}.tsx` | separate read lifecycle using the existing keyed `useResource` contract; no added selection controls; no client sort; reading progress invalidates library facts and remaining order |

agree schemas first; a/b coordinate through read ports, c consumes schemas, d
integrates. adversarially review every track before integration. integration owner
updates module docs, architecture ownership and issue records; delete tickets only
after acceptance. no repository-wide documentation repair or unrelated cleanup.

## acceptance

1. section order is queue → quick reads → at hand on desktop/mobile. zero through
   five rows, ordinary opening, no new controls or relation copy/expander. resource
   connections remain accessible after opening media.
2. an eligible candidate survives when earlier candidates exceed ten minutes;
   selection applies eligibility before acquisition caps. queue membership/fullness
   does not suppress quick reads. overlap between sections remains legal.
3. no cursor, empty cursor, known position, positioned-unknown and exact-end states
   produce the specified estimates. moving backward below completion increases
   remaining time. returning earlier after completion does not implicitly undo it.
4. raw 599.9 seconds qualifies; 600 and zero do not. zero displays zero elsewhere.
   positioned pdf/unknown durations are excluded and sort last. readiness and
   visibility failures never produce quick-read rows.
5. remaining ascending/descending works beyond page one, through equal values and
   unknowns, with deterministic identity ties. a saved position invalidates an old
   continuation; existing view filters, canonical reorder and other sorts work.
6. library and quick-read labels agree for the same saved position, including after
   `SetUnread`. known remaining time replaces percentage in reading rows; audio
   presentation is unchanged. dates come from their factual owners, not reasons.
7. pane return/progress changes refresh; errors differ from empty results; retired
   endpoint and old slate payloads have no runtime consumer or compatibility path.

automated checks: only `./scripts/test`. manually verify representative real media
and two library pages; inspect actual-corpus query plans for the sort/candidates.
no text-body scans, per-item queries, persistent caches or new test harness.

## explicit tradeoffs

- reuse of existing relevance can yield fewer than five despite other short works.
- fixed 240-wpm and position-proportional text length remain approximate; positioned
  pdfs stay unknown. no calibration or page-uniform duration guess.
- duration-bearing reading rows lose percentage display to avoid mixing two
  different progress meanings. completion/high-water history stays intact.
- independent reads add a request and initial loading interval; they avoid coupling
  quick reads to at hand's mutation lifecycle. overlapping results are allowed.
- one additional counter in the existing consumption snapshot distinguishes cursor
  changes from audio heartbeats. duration changes refresh every library view;
  reconciliation retains its existing first-page replacement behavior. ordinary
  unfiltered views do not newly reset pagination on audio heartbeats.
- deleting inline related discovery also removes its transient similarity endpoint;
  stored human/ai connections and resonance ranking remain.
