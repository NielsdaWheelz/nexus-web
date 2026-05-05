# Black Forest Oracle — Eternal Edition (Hard Cutover)

Supersedes the corresponding sections of
`docs/black-forest-oracle-hard-cutover.md`. This spec elevates the oracle
from a moody single page to a *leaf of an actual book*: structured arc,
illuminated capital, illuminated borders, named folios, Miltonic
argument, fleurons, colophon. No legacy code, no fallbacks, no
backwards compatibility.

## Role

A scribe-illuminator. Every reading is a leaf in the user's private
codex. The page has structure, ornament, and the dignity of a real
book — not a webpage themed to look old.

## Goals

1. Each reading is a **journey**, not a list: descent → ordeal → ascent.
2. Each reading has a **name**: *Folio XII · The Solitary Lamp.*
3. Each reading is **illuminated**: a drawn capital and a worked border.
4. Each reading **closes like a book**: a colophon with date, plate
   attribution, and typeface credits.
5. The reader's library becomes a **codex** — a sequence of named
   folios, not a list of questions.
6. Citation integrity is preserved: visible quote / locator /
   attribution always come from corpus rows, never the model.

## Non-Goals

- No multiple plates per reading.
- No color illumination — Doré is monochrome ink, Blake's black-line
  conviction. Color dilutes.
- No additional fonts beyond the three already loaded (EB Garamond,
  IM Fell English, UnifrakturMaguntia).
- No regenerate-with-different-arc affordance.
- No print/PDF export, audio, RSS, share-folio links, refusal mode.
- No 26 hand-drawn illuminated letters; one component renders any
  letter with deterministic decorative motif behind it.
- No backwards compatibility with the previous reading shape: passages
  drop `ordinal` in favor of `phase`; readings gain three new columns;
  migration `0072` is edited in place.

## Final State

A reading page renders, top to bottom, inside a worked border:

1. **Folio header.** *Folio XII · The Solitary Lamp.* Roman numeral,
   middle dot, fraktur title.
2. **Question.** The user's question, in fraktur.
3. **Argument.** One italic small-caps line summarizing the soul's path
   through the reading, Miltonic cadence. Centered.
4. **Plate.** Single Wikimedia public-domain engraving (Doré, Blake,
   Redon, etc.). Same as today.
5. **Three passages.** Each labeled in small caps:
   *I. The Descent / II. The Ordeal / III. The Ascent.* Marginalia
   gutter to the right at ≥1024px.
6. **Interpretation.** Synthesis paragraph(s). Opens with an
   illuminated capital — SVG decoration drawing in over ~2s, fraktur
   letter at center. Floated left, prose wraps around.
7. **Omens.** 2–4 lines of imagery, fleuron bullets.
8. **Colophon.** *Composed for N. on the third of May, MMXXVI. Plate
   after Doré. Set in EB Garamond, IM Fell English, and
   UnifrakturMaguntia.*

Section breaks throughout use centered fleurons (❦) — no horizontal
rules anywhere on the oracle surface.

The landing page's recent-readings list shows folio number + title as
primary line, the question as a secondary italic line beneath.

## Target Behavior

### The reading page

- On first paint, the page renders question + folio header. The plate,
  argument, passages, interpretation, omens stream in via SSE.
- The illuminated capital animates on mount of the interpretation
  section: decoration paths draw in (~1.8s via stroke-dasharray); the
  fraktur letter is visible from the start (the scribe writes; the
  illuminator decorates afterward).
- `prefers-reduced-motion` skips both the capital draw-in and any
  border vine animation; everything else (fade-ins) was already gated.
- Reload mid-stream resumes via SSE replay from the persisted cursor.
  The argument, folio_title, plate, and any received passages are
  restored from the persisted reading detail; the capital animates
  again on next mount. (Acceptable — it is a nice flourish.)

### The landing page

- Recent readings render as:
  ```
  Folio XII · The Solitary Lamp
    What does it mean to keep a lamp lit through the night?
  ```
  Folio + title in fraktur, question in italic body beneath. Click
  navigates to the reading.
- Pending readings (folio_title not yet generated) show
  *Folio XII · ……* with a soft ellipsis until the bind event arrives.
- Empty state untouched.

### LLM behavior

The model now produces, in one structured-JSON call:

```json
{
  "argument": "Of the longing for unbroken light, and the lamp the soul keeps lit when the wood grows close.",
  "folio_title": "The Solitary Lamp",
  "passages": [
    {"phase": "descent", "candidate_index": 4, "marginalia": "..."},
    {"phase": "ordeal",  "candidate_index": 0, "marginalia": "..."},
    {"phase": "ascent",  "candidate_index": 7, "marginalia": "..."}
  ],
  "interpretation": "...",
  "omens": ["...", "...", "..."]
}
```

System prompt is updated to:

- Define each phase: descent (the ground falling away, recognition of
  the shadow), ordeal (the wrestling, the standstill), ascent (the
  breaking through, the dawn).
- Require *exactly three* passages, one per phase, distinct
  candidate_index values. The model picks which corpus passage best
  fits each phase by tone and image, not by candidate order.
- Require an `argument`: one sentence, ~80–180 chars, Miltonic
  blank-verse cadence, beginning *"Of …"*.
- Require a `folio_title`: 2–4 words, evocative, no articles
  (*The Solitary Lamp*, *The Burning Wheel*, *Shoreline of Sleep*).
  Capitalized like a book title.
- Citation integrity: as before, the LLM never produces the visible
  quote, locator, or attribution string.

## Rules

### Citation integrity (preserved, restated)

- The LLM picks `candidate_index` and writes `marginalia` only.
- The visible `exact_snippet`, `locator_label`, `attribution_text`,
  `deep_link` always flow from the corpus row.
- The LLM also writes `argument`, `folio_title`, `interpretation`,
  `omens`. None of these are citations; they are the oracle's voice.

### Tripartite arc

- A reading has *exactly three* passages.
- Phases are `descent`, `ordeal`, `ascent` — no other values.
- Each phase appears exactly once per reading (UNIQUE constraint).
- Render order is fixed: descent → ordeal → ascent.

### Folio numbering

- `folio_number` is a positive integer, sequential per user, never
  re-used. Computed server-side at create time as `MAX + 1` from the
  user's existing readings (held under a row-level advisory lock or
  retried-on-conflict; see Architecture).
- A failed reading still consumes its folio number — the codex shows
  the gap honestly. (No renumbering.)
- `folio_title` is a string set when streaming completes. Pending
  readings render with an ellipsis in place of the title.

### Reduced motion

- Existing animation gates remain.
- New gates: illuminated capital decoration paths skip stroke-dash
  animation under `prefers-reduced-motion`.
- Border illumination is static SVG; no animation to gate.

## Architecture

### Data model changes (migration 0072 edited in place)

`oracle_readings`:

| Column          | Type                                              | Notes                                                 |
|-----------------|---------------------------------------------------|-------------------------------------------------------|
| folio_number    | Integer NOT NULL CHECK (folio_number > 0)         | sequential per user                                   |
| folio_title     | Text NULL                                         | LLM-generated; null until bind event                  |
| argument_text   | Text NULL                                         | LLM-generated; null until argument event              |

UNIQUE(user_id, folio_number).

`oracle_reading_passages`:

| Column   | Type                                                                             | Notes                                |
|----------|----------------------------------------------------------------------------------|--------------------------------------|
| phase    | Text NOT NULL CHECK (phase IN ('descent','ordeal','ascent'))                    | replaces ordinal                     |

UNIQUE(reading_id, phase). The previous `ordinal` column is removed.
Frontend sort uses a small `PHASE_ORDER` constant.

No other schema changes. Corpus tables, image table, events table
are untouched.

### Service layer (`python/nexus/services/oracle.py`)

Public surface unchanged. Internals:

- `create_reading`: opens a transaction, computes `folio_number = MAX
  + 1` for the user, inserts the row, and relies on the UNIQUE
  constraint plus transaction retry for concurrent creates. The
  folio_number is returned in the create response.
- `execute_reading`: same lifecycle as before, with these new event
  emissions in order:
  1. `meta` (existing) — question, folio_number
  2. `bind` — folio_title (after LLM completes)
  3. `argument` — argument_text (after LLM completes)
  4. `plate` (existing)
  5. `passage` × 3 (existing shape, plus phase) — emitted in phase
     order: descent, ordeal, ascent
  6. `delta` (existing) — interpretation
  7. `omens` (existing)
  8. `done` (existing)

  The model is called once and produces the full structured JSON; the
  service then unpacks fields into individual events for the stream.
  This keeps the LLM call simple and the streaming UX smooth.

- LLM prompt: extended to describe phases, require exactly three
  passages, require argument + folio_title, all in the same
  structured-JSON contract. ~30 LOC of additional prompt text. No new
  LLM call.

### SSE event types

Added to the existing event stream (replayed verbatim from
`oracle_reading_events`):

| event     | payload                                                                            |
|-----------|------------------------------------------------------------------------------------|
| `bind`    | `{"folio_title": "The Solitary Lamp"}`                                             |
| `argument`| `{"text": "Of the longing for unbroken light, …"}`                                 |
| `passage` | adds `phase: "descent" \| "ordeal" \| "ascent"`; drops `ordinal`                  |

`meta` payload also gains `folio_number: int`. (Non-breaking shape; the
frontend hydrates folio_number from the reading detail on first
paint, so this is mostly for replay completeness.)

### Frontend components

New, small, scoped to oracle:

- `apps/web/src/components/oracle/IlluminatedCapital.tsx`
  - Renders an inline SVG: decoration paths in `var(--oracle-gold)`
    plus a `<text>` element for the letter in
    `var(--font-oracle-fraktur)`.
  - Five inline path templates (vine, flame, serpent, star,
    ouroboros) — one chosen by `hash(question) % 5`.
  - Decoration animates via `stroke-dasharray` + CSS `@keyframes`
    drawing in over 1.8s. Letter is visible immediately.
  - `prefers-reduced-motion`: animation skipped.
  - Floats left within the interpretation section; CSS Module class
    handles size (~3.5em width / height).

- `apps/web/src/components/oracle/BorderFrame.tsx`
  - Renders four absolutely-positioned SVGs around the surface: top
    header (vines + small flames at corners), bottom footer
    (mirrored), left side rule (vertical vines), right side rule
    (mirrored). Same border for every reading — book consistency.
  - Pure decoration, `aria-hidden="true"`, `pointer-events: none`,
    static (no animation).
  - SVG path data drafted by sub-agent at implementation; ~80 LOC of
    inline `<path d="…">` per piece.

Inline (in `OracleReadingPaneBody.tsx`) helpers:

- `Colophon` — small function component declared at module scope.
  Reads `display_name` (first letter only, with period), composed
  date, plate artist (already in the image payload). Hardcoded font
  list in the JSX.
- `ordinalEnglish(day: number)` — module-level helper, ~25 LOC.
  *first / second / third / … / thirty-first.*
- `toRoman(year: number)` — module-level helper, ~15 LOC.
  *MMXXVI* for 2026.
- `formatColophonDate(date: Date)` — composes the two helpers into
  *"the third of May, MMXXVI"*.

These are inlined in the reading body, not extracted to a util module:
they are used in one place, reading them in-place is faster than
jumping to a file.

Fleurons are pure unicode (❦) with a small CSS class `.fleuronBreak`
that centers them with a thin gold line either side. Replaces every
`border-top: 1px solid var(--oracle-rule)` between reading sections.

## Files Changed

### Backend (4 files modified)

- `migrations/alembic/versions/0072_oracle.py`
  - oracle_readings: add folio_number, folio_title, argument_text
  - oracle_reading_passages: drop ordinal, add phase + check
  - UNIQUE(user_id, folio_number) on oracle_readings
  - UNIQUE(reading_id, phase) on oracle_reading_passages

- `python/nexus/db/models.py`
  - OracleReading: add folio_number, folio_title, argument_text
  - OracleReadingPassage: drop ordinal, add phase

- `python/nexus/schemas/oracle.py`
  - OracleReadingDetailOut: add folio_number, folio_title,
    argument_text
  - OracleReadingSummaryOut: add folio_number, folio_title
  - OracleReadingPassageOut: drop ordinal, add phase
  - OracleReadingCreateResponse: add folio_number

- `python/nexus/services/oracle.py`
  - create_reading: compute and persist folio_number
  - execute_reading: emit bind, argument events; passages carry phase;
    LLM prompt updated; structured-JSON parsing handles new fields

### Frontend (4 files modified, 2 new)

- `apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx`
  - State: add foliotitle, foliumNumber, argument
  - Render: Folio header, Argument line, phase-labeled passages,
    IlluminatedCapital in interpretation, Colophon at end, BorderFrame
    wrapping, fleurons between sections
  - applyEvent handles bind, argument; passage carries phase
  - Inline Colophon + date helpers

- `apps/web/src/app/(authenticated)/oracle/OracleLandingPaneBody.tsx`
  - Recent readings list renders folio_number + folio_title primary;
    question secondary italic

- `apps/web/src/app/(authenticated)/oracle/oracle.module.css`
  - New classes: `.foliumHeader`, `.foliumNumber`, `.foliumTitle`,
    `.argument`, `.passagePhase`, `.passageDescent`, `.passageOrdeal`,
    `.passageAscent`, `.illuminatedCapitalWrap`, `.colophon`,
    `.fleuronBreak`, `.borderFrame*`
  - Replace section `border-top` rules with `.fleuronBreak` styling
  - `.passage` no longer relies on `ordinal`; styled by phase modifier

- `apps/web/src/app/(authenticated)/oracle/page.tsx` — no change.

- `apps/web/src/components/oracle/IlluminatedCapital.tsx` — new.

- `apps/web/src/components/oracle/BorderFrame.tsx` — new.

## Key Decisions

1. **Edit migration 0072 in place** rather than create 0073. The
   previous migration has not been applied to any production database
   (per the prior agency report), and a true hard cutover keeps the
   oracle data model in a single migration file. Easier to read,
   easier to roll back, easier to audit.

2. **Drop `ordinal` in favor of `phase`.** The ordering is now
   semantic, not numeric. `PHASE_ORDER = ['descent', 'ordeal',
   'ascent']` lives in one constant on the frontend.

3. **Folio number is computed server-side at create time**, not on LLM
   completion. A failed reading still occupies its folio. The codex
   reflects the truth of the user's asks, including the ones that
   broke. Numbering uses INSERT + retry on UNIQUE-violation rather
   than table-level locking — concurrency-safe and minimal.

4. **Folio title and Argument are LLM outputs**, streamed via new SSE
   events. Single LLM call produces all fields in one JSON payload;
   the service unpacks into separate events for the stream. The model
   does not see the folio number — it is naming the *reading*, not
   numbering the codex.

5. **Exactly three passages.** The arc demands precisely three. The
   LLM picks which of the 6+2 candidates fits each phase by tone, not
   by index order.

6. **One IlluminatedCapital component**, not 26 hand-drawn letters.
   The decoration is the SVG illumination; the letter is rendered as
   `<text>` in UnifrakturMaguntia. Five decorative motifs cycle
   deterministically by question hash. ~150 LOC including templates
   and animation.

7. **Single border for every reading.** Book-consistency. The SVG
   border is the codex's binding, not a per-reading flourish. ~250
   LOC of inline `<path>` data across four edge pieces.

8. **No util module for date formatting.** `ordinalEnglish` and
   `toRoman` live at the top of `OracleReadingPaneBody.tsx`. Used
   once. Inline helpers, not extracted.

9. **Fleurons are unicode, not SVG.** `❦` rendered in a styled span.
   Free, accessible, period-correct. CSS gives it gold color and
   thin lines either side.

10. **`Colophon` is inlined in the reading body** as a function
    component. One use site, ~30 LOC. Reading the JSX top-to-bottom
    explains the page; jumping to a Colophon module would obscure it.

11. **No animation on the border.** Static is right — Blake's borders
    don't move. Animating them would feel theatrical, not eternal.

12. **Pending folio titles render with an ellipsis** until the bind
    event arrives, rather than hiding the row. The folio number is
    known immediately; only the title is pending. Soft visible state
    is better than late-appearing rows.

## Acceptance Criteria

### Backend

- [ ] Migration 0072, freshly applied, creates oracle_readings with
      folio_number / folio_title / argument_text and
      oracle_reading_passages with phase (no ordinal).
- [ ] UNIQUE(user_id, folio_number) prevents duplicate folios per
      user.
- [ ] UNIQUE(reading_id, phase) prevents two passages with the same
      phase on a reading.
- [ ] `POST /oracle/readings` returns folio_number in the response;
      backend has assigned MAX+1 for the user.
- [ ] `GET /oracle/readings/{id}` returns folio_number, folio_title,
      argument_text, and three passages each carrying phase.
- [ ] `GET /oracle/readings` (recent) returns folio_number and
      folio_title for each summary.
- [ ] SSE replay endpoint replays bind, argument, and the new shape
      of passage events without modification.
- [ ] LLM prompt produces exactly three passages with distinct phases
      drawn from descent / ordeal / ascent. (Manual smoke test on
      five varied questions.)
- [ ] Pyright clean. Ruff clean.

### Frontend

- [ ] Reading view renders, top to bottom: Folio header (number +
      title), question, argument, plate, three phase-labeled
      passages, interpretation with illuminated capital, omens,
      colophon — all wrapped in the BorderFrame, with fleurons
      between sections (no horizontal rules anywhere on the oracle
      surface).
- [ ] Phase labels render as *I. The Descent* / *II. The Ordeal* /
      *III. The Ascent* in fraktur small caps above each passage.
- [ ] IlluminatedCapital animates on mount: decoration draws in over
      ~1.8s; letter visible from the start. Skipped under
      `prefers-reduced-motion`.
- [ ] Argument renders italic small caps, centered, between question
      and plate.
- [ ] Colophon renders at the foot:
      *Composed for [N]. on the [ordinal] of [Month], [MMXXVI].
      Plate after [Artist]. Set in EB Garamond, IM Fell English, and
      UnifrakturMaguntia.*
- [ ] BorderFrame wraps the surface with top header, bottom footer,
      left and right side rules. Static, monochrome (gold on dark).
- [ ] Recent readings list shows *Folio XII · The Solitary Lamp* as
      the primary line; question as secondary italic. Pending
      readings show ellipsis in place of title.
- [ ] Reload mid-stream resumes via SSE replay; bind / argument
      events restored from event log.
- [ ] TSC clean. ESLint clean. No inline lint disables.

### Citation integrity

- [ ] Visible quote / locator / attribution text on every passage
      come from the corpus row, not the LLM. (Verified by inspecting
      the persisted event payloads — passage events carry corpus
      fields, the LLM only produced phase + marginalia.)

## Cutover Plan

1. Edit `migrations/alembic/versions/0072_oracle.py` to include the
   new columns and constraints. Regenerate the rest of the file
   downstream (ORM, schemas, service) to match.
2. Update LLM prompt in `services/oracle.py`. Smoke-test on a few
   varied questions with `ANTHROPIC_API_KEY` set.
3. Build IlluminatedCapital and BorderFrame components. Hand the
   SVG path drafting to a sub-agent. Verify in Storybook-style
   isolation by mounting a stub reading page.
4. Update `OracleReadingPaneBody.tsx` to render the new layout and
   handle new events. Update `OracleLandingPaneBody.tsx` for the
   recent-readings shape.
5. Update `oracle.module.css` for new classes; replace all
   `border-top` rules with `.fleuronBreak`.
6. Run pyright + ruff + tsc + eslint; iterate until clean.
7. Manual end-to-end: migrate, seed, ask a question, watch the
   reading stream in. Reload mid-stream to confirm replay.

## Risks

1. **LLM phase fidelity.** The model may cluster passages of similar
   tone (all three feeling like "ordeal"). Prompt engineering and the
   explicit phase definitions are the mitigation; if it persists,
   fall back to a server-side post-check that rejects phase-incorrect
   output and retries once.
2. **SVG path complexity.** Border illumination drafted by sub-agent
   may look generic or busy. Iterate visually; budget two passes.
3. **Colophon date in non-English locales.** The colophon hardcodes
   English ordinals and month names. Acceptable for v1; the oracle is
   English-only by content.
4. **Folio number race on parallel asks.** Two simultaneous POSTs
   from the same user could race on MAX+1. Mitigated by the UNIQUE
   constraint and a retry-on-IntegrityError loop in `create_reading`.
5. **Migration 0072 already applied somewhere.** If a developer
   has applied it locally, they will need to drop and recreate the
   six oracle tables before the edited migration applies. Documented
   in the cutover steps.
6. **Citation integrity automated test still missing** (carried
   forward from the prior spec). The contract is enforced by code
   path; the test gap remains.

## Out of Scope (Maybe Later)

- Animated illumination of the border (Blake's vines unfurling on
  page load).
- 26 hand-drawn illuminated letters.
- Refusal mode for shallow questions.
- Continuous numbering across all users (a single global codex).
- Print-quality PDF export of a folio.
- Cross-references between folios in marginalia
  (*see also: Folio III*).
