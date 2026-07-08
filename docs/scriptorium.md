# Nexus Scriptorium — the working-house thesis

Status: IDEAS — written 2026-07-06 from a second recon+ideation pass (10 mappers
across product / design / ontology / AI machinery / reader / ingest / search /
frontend state / docs / debt; ideation by Fable). Third of a set: `horizons.md`
(the ambient thesis), `dreams.md` (the argument thesis), this (the working-house
thesis). It does not compete with the argument sequence — it builds the house
the argument happens in.

## The one-line diagnosis

Dreams answered *what the corpus should say*: it should argue. This answers
*where it says it, with what hands, on whose clock, from what memory, through
which press*. Recon found five load-bearing absences no vision doc has named:

1. **The apparatus engine only serves the dead.** Nexus already parses,
   anchors, and typesets scholarly marginalia — footnotes, sidenotes,
   bibliographies, Gwern/Tufte conventions — but exclusively the *source's
   own*. Your annotations live in a parallel sidecar; machine findings live in
   drawer tabs. The one subsystem that knows how to put writing in the margin
   of a text has never been handed your writing.
2. **The house agent has no hands.** Every chat tool is read-only
   (`app_search`, `web_search`, `read_resource`, `inspect_resource`).
   Horizons' entire thesis is agents as co-authors under provenance — and the
   most-used agent in the product cannot write a single edge.
3. **The night is idle and the meter is already installed.** All five periodic
   jobs are housekeeping, while `llm_calls` carries full USD-micros cost
   accounting per call (mig 0152). Scheduled intelligence isn't blocked on
   plumbing; it's blocked on nobody having designed the shift roster.
4. **The corpus doesn't know what you attended to.** No reading-session entity
   exists anywhere in ~100 tables. Read-state is inferred from scroll saves;
   resonance ranking is impersonal. The one signal that would make every
   ambient feature *yours* — dwell — is discarded on the reader's floor.
5. **Two presses, soon four.** `media_summaries` and LI artifact revisions are
   near-isomorphic engines; dreams' Canon needs a corpus-scoped third and the
   View Compiler a question-scoped fourth. That is one engine with a
   `subject_ref`, not four subsystems.

The scriptorium is the room where texts were copied, glossed, and bound: a
margin to write in, scribes with hands, night work by candle, and one press.
Nexus has the doctrines of that institution; what follows staffs it.

## I. The Second Apparatus — the place

A user- and machine-authored critical apparatus over every text, rendered
inline with the same conventions the reader already honors for source-authored
apparatus. Not a new pane; the margin itself.

- **Passage-grain resonance.** Widen synapse edge targets from media/note_block
  grain to evidence-span grain (one CHECK widening; retrieval already returns
  chunks with `primary_evidence_span_id`). A media-grain "this book relates"
  can't live in a margin; a span-grain rationale *is* a sidenote.
- **Highlight notes become margin notes.** They are already anchored to exact
  offsets; render them at their anchor in the apparatus register instead of
  exiling them to the sidecar. The quick-note composer becomes what it always
  wanted to be: writing in the margin.
- **The cross-document footnote.** From any selection, cite a passage in
  another work — a user-origin edge to an evidence span in a different media.
  The reader's largest annotation gap (nothing can point from document A to a
  passage in document B) dissolves into machinery that already exists:
  `resource_edges` + text-quote selectors + apparatus rendering.
- **Take a Side lives here.** Dreams' conceding tick / doubting tilde gets its
  physical location: the margin, beside the passage, in your hand's register —
  machine glosses beside it in the Machine Hand.

Payoffs: Synapse leaves the drawer and appears where reading happens; the
sidecar-vs-inline split ends (dreams' "6 tabs → 2" happens as a consequence,
not a cleanup); "marginalia" becomes a search kind; and the reader — already
the crown jewel — becomes the surface where the argument era lands.

## II. The Amanuensis — the hands

Write tools for the chat agent, under the origin discipline that was designed
for exactly this (provenance N9: a new writer is a new origin):

- `add_to_library`, `file_note` (append to a page or daily note),
  `create_highlight` (anchored via the existing text-quote selector machinery),
  `mint_edge` (context / supports / contradicts, origin `assistant`),
  `set_queue`.
- Every write origin-marked, surfaced in the turn's trust trail, reversible.
  Sole-writer doctrine holds. The harness's own economics say each tool is
  ~60 lines of domain code.
- The explicit-UI doctrine holds too: the agent proposes and files; destructive
  verbs still confirm. This is dictation, not automation — "file this under
  Criticism, dog-ear that passage, connect these two" said in words instead of
  clicks.

The product shift is from *chat about your library* to *dictate to your
librarian*. It is the cheapest deep change in this document.

## III. The Night Shift — the clock

A roster, a governor, and a press sheet — the system design horizons gestured
at ("works while you sleep") but never specified:

- **Roster.** Nightly: `stance_scan` (dreams' Argument job), stale LI
  regeneration (horizons' self-healing), conversation distillation (§V),
  embedding-drift repair, dawn/vespers composition. Each is an existing-shape
  job: prompt + schema + job kind.
- **Governor.** A nightly USD budget enforced from `llm_calls` before each
  task claims work. The meter exists; the governor is a query and a gate. When
  local-tier models arrive (horizons' 5-year), the governor is the swap point —
  the roster doesn't change, the unit cost does.
- **Press sheet.** One morning block in the daily note, set in the Machine
  Hand: what ran, what it wrote, what it cost. The institution keeps books.
  No feed, no badges; the Vespers doctrine governs.

## IV. The Attention Ledger — the memory

A `reading_sessions` entity: media, span ranges touched, dwell time, device,
timestamps — written by the same debounced path that already saves resume
state. Single-user, never displayed as a productivity metric. It is memory,
not measurement.

Payoffs compound everywhere: honest read-state (the deferred
`consumption_state` follow-up gets its substance, and "mark as read" can
finally be a verb); resonance ranking learns what you lingered on rather than
what you happened to save; Temporal Echo and Year-in-Reading stop being SQL
over `created_at` and become a record of attention; the Canon weighs dwelled
evidence over skimmed. This is the signal that makes every ambient feature
personal, and it is currently thrown away.

## V. One Press — the artifact engine

Generalize the LI artifact/revision engine to `artifacts(subject_ref)`: one
stable head + immutable revisions + citations + freshness fingerprints, at any
scope —

- media-scoped (absorbs `media_summaries`),
- library-scoped (today's LI),
- corpus-scoped (dreams' Canon),
- question-scoped (the View Compiler; document answers).

One engine, four products, and an isomorphism deleted. First new customer:
**conversation distillation** — when a conversation goes quiet, the night
shift distills it into grounded claims (message-anchored, `ground_indices`)
on its artifact. Transcripts become compostable (dreams' Compost gets its
mechanism) and conversations finally become semantically retrievable without
embedding a single transcript. The transcript dies; its claims survive.

## VI. The Correspondence — chat leaves the bubble

The chat surface is the one place still wearing the generic-AI costume
(bubbles, `--radius-2xl`) — the recon's design pass named it the least-Nexus
surface in the app. Re-typeset the conversation as an editorial exchange:
your words as set queries in your register, answers as set prose with
footnote-style citations (the server already builds them), a hairline
attribution rail in the Machine Hand, and a **colophon** closing every
generated artifact — model · tokens · cost · sources, the printer's mark.
Honesty as ornament; the ledger data is already there.

## VII. Delights

- **The Docent** — any cited answer offered as a guided walk: one keystroke
  steps through the actual passages, pane by pane, via the evidence deep-links
  and `openInNewPane` choreography that already exist. The cheap, honest form
  of "generated UI."
- **The Grand Atlas** — Oracle's star map generalized to the whole library: an
  engraved celestial chart where constellations are libraries, stars are
  works, faint lines are synapse edges, and red-gold lines are contradictions.
  The stance era's visual argument, and the manuscript register's second
  escape from the Oracle.
- **The Lectern & the Chapbook** — one consumption queue across kinds (audio
  already has `playback_queue_items`; text has nothing), and mobile reframed
  as the queue + reader + pulse device instead of a shrunken twelve-pane
  workspace it can't render anyway.
- **The Post Room** — a private ingest email address. Newsletters are the
  largest missing mouth for a serious reading tool; senders resolve through
  the contributor identity system, which is already built to exactly this
  depth (aliases, merges, external IDs) and finally earns it.

## VIII. The desk must be cleared

Sequencing honesty — parked work that predates all dreaming:

1. **`codex/search-retrieval-roadmap` — merge or kill.** Sixteen commits,
   ~30k lines, green, unmerged; both it and main now claim migration 0168.
   Every week it sits, the rebase worsens. Nothing in this document should be
   built before this branch has a verdict.
2. **The LI dossier surface.** Three migrations of substrate shipped for a
   product surface that was never built. Either build it as the first face of
   One Press or fold its spec into §V and close it.
3. **First-paint streaming.** Fully specified, measured baselines, zero lines
   written, user-facing on every load.
4. **The `file_sha256` landmine.** `models.py` (~line 1186) still references a
   column dropped in mig 0138 inside a partial-index text expression — silently
   wrong on fresh databases. Ten-minute fix.

## Declined

- **Multi-user / presence.** The data layer is honestly single-writer, the
  doctrine is single-user, and nothing above needs it. Hold.
- **Spaced repetition.** Measurement dressed as ritual. The Attention Ledger
  remembers; it does not quiz.
- **Auto-ingest feeds.** Dreams already declined this; the line holds.
  Watchman and Expedition remain the consented forms.
- **Generated-per-moment UI.** The 10-year projection, premature. The Docent
  is its honest cheap version.
- **A second chat mode.** The Correspondence re-typesets the one that exists;
  it adds nothing to choose between.

## If only one thing

The Second Apparatus, at passage grain. It is the enabling organ for dreams'
entire stance sequence — Take a Side needs a margin to put the tick in; The
Argument needs passage-grain edges to be readable where you read; the Machine
Hand needs a place to write, not just a face to wear. Build the margin and
the argument era lands in the text itself, where it always belonged.

## Provenance

Generated 2026-07-06 by a 10-mapper recon fan-out (product surfaces, design
language, domain ontology, AI machinery, reader/annotation, ingest/workers,
search/retrieval, frontend state, docs sweep, loose ends) with ideation and
curation by Fable 5. Single editorial voice; no consensus claimed.
