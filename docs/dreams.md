# Nexus Dreams — the argument thesis

Status: IDEAS — written 2026-07-06 from a 14-lens / 18-agent ideation fan-out
(65 ideas). Sibling to `horizons.md` (the ambient thesis). Nothing here is built
or committed to; this is the curated shortlist. Ten items were expanded into
full hard-cutover specs on 2026-07-07 (adversarially reviewed); they are linked
inline below as `→ spec`.

## The one-line diagnosis

The stance vocabulary is loaded and has never been fired: `resource_edges` has
carried `supports`/`contradicts` since mig 0147, `media_claims` holds grounded
assertions from every ingested document, and horizons.md names contradiction
surfacing as the killer feature nobody ships. Era 1 made the substrate honest;
Era 2 (Synapse) made it ambient; **Era 3 makes it argue** — the corpus as a
record of what you believe, what contradicts it, and what's unresolved.

Convergences across independent lenses:

- **Fire the stance vocabulary** (5 lenses landed here independently).
- **Oracle typography escapes the Oracle** — the manuscript register
  (`[data-theme='oracle']`, EB Garamond, marginalia) applied to generated
  artifacts app-wide.
- **Document answers over chat transcripts** — nobody rereads a chat log.

## Act I — the Machine Hand (design)

- **Machine Hand**: provenance is tracked but never typeset. Machine text gets
  its own register — contrasting face, cooler ink, hairline attribution rail,
  small-caps origin signature (`SYNAPSE · 06:14`) — like a scholarly edition's
  critical apparatus. One `MachineText` owner component; every ambient feature
  inherits an honest voice. ~One cutover.
  → spec `cutovers/machine-hand-hard-cutover.md`
- **Running Journal**: every pane gets a periodical's running head (small-caps
  standing head + live folio); kills the last dashboard-itis above ResourceRow.
  → spec `cutovers/running-journal-hard-cutover.md`
- **Two Rooms**: dark mode stops being an inversion. Day = "the Study" (warm
  cream, lamplight); night = "the Press" (cooler ink, opened tracking, thicker
  hairlines, canvas-wide grain). Tokens only; a weekend.
  → spec `cutovers/two-rooms-hard-cutover.md`

## Act II — fire the loaded gun (product)

In order:

1. **The Argument** — `stance_scan` job after `media_unit_build`: new claims
   checked against semantically-near claims from other documents; genuine
   oppositions become `contradicts` edges with one-line rationales. First real
   writer of the stance vocabulary. One migration + one service mirroring
   `synapse.py`.
2. **Take a Side** — two-key chord in the reader minting a *user-origin* stance
   edge (conceding tick / doubting tilde in the margin). No dialog, no AI. The
   human finally gets an opinion in their own graph.
3. **The Reckoning** — weekly disputation spread: two cited quotes facing each
   other across a center rule; verbs *side with · hold both · not a
   contradiction*. Every ruling writes a stance edge or suppression.
4. **Ledger of Positions** — coin a belief as one signed sentence; reading files
   in behind or against it in two columns. Standing (*settled / contested /
   eroding*) derived from evidence balance, never set by hand.
5. **The Canon** (epoch) — the LI artifact/revision engine pointed at the whole
   corpus: book-length, nightly-regenerated, sentence-cited portrait of your
   positions, typeset as a manuscript; ratify paragraphs into Positions or
   rebut them in its margins. Plus **Advocatus**: a named weekly adversary
   filing the strongest cited case your own library can make against your most
   settled belief (*concede / rebut / dismiss*).

## Act III — the substrate escapes the pane (horizon)

- **Nexus MCP** — `search`/`read`/`cite-under-own-origin` behind an MCP
  transport with an `extension_sessions`-style named-agent bearer. External
  agents read your highlights and file evidence as themselves. Horizons' 5-year
  bet; buildable in a weekend.
- **View Compiler** — a question returns a typeset, footnoted document (one new
  `structured_synthesis` schema), not a thread. Later heresy worth revisiting:
  **the Interlocutor** — answers stream into a page you own; the transcript
  dies.
- **Printed projections** — **Year in Reading** (critic's letter, cited),
  **Quarterly** (most-connected marginalia as a printable journal), **Standing
  Volume** (the library continuously composed as one book; `Cmd-P` to a press).
- **Ambient Frame** — chromeless `/ambient` route for an e-ink wall frame:
  yesterday's reading, newest resonances, one thing long unopened.

## The pulse — governed by the Vespers heresy

- Ambient tools die of resurfacing fatigue; never build the feed.
- **Dawn Write**: one machine block (two short cited paragraphs, Machine Hand)
  above the blank daily note; one-tap dismissible with memory.
  → spec `cutovers/dawn-write-hard-cutover.md`
- **Vespers**: a once-a-day, summoned-only composed reading of what settled
  since the last visit. No badges, no counts, ever.
- **Temporal Echo**: a highlight from this date in a prior year, verbatim, no
  prompt attached. **Drift Protocol**: the old highlight nothing ever connected
  to, given one more chance. Both ~SQL-only weekends.

## Delights (cheap, body- and ritual-shaped)

- **Voice Marginalia** — hold M, speak into the margin; Deepgram → quick-note
  composer.
- **Walknotes** — tap the player mid-podcast, speak; come home to a highlight
  anchored to that transcript line with your voice beneath it.
  → spec `cutovers/walknotes-hard-cutover.md`
- **Sortes** — cast the Oracle without a question; recency-weighted toward the
  forgotten. **The Text Reads Itself** — cast a reading from a highlight.
  **The Vigil** (epoch) — a declared 7/21/40-day arc of daily unbidden readings.
- **The Watchman** — flag a claim; when the world publishes against it, the
  rebuttal arrives already stance-typed (explicit per-claim consent).
- **The Expedition** — commissioned audit of what the corpus *doesn't* cover on
  a question; gaps justified by the shape of what you've read; cited reading
  plan.
- **Compost** — a third verb between keep and delete: distill one sentence of
  residue, retire the object from all surfaces (no-cascade doctrine holds).

## The subtraction ledger

- **Browse dies** — Launcher add-lane + Search already own it (523 lines).
  → spec `cutovers/browse-surface-deletion-hard-cutover.md`
- **Today dies as a surface** — a 119-line date-lookup wrapper around Notes;
  keep `daily_note_pages`, move "jump to today" into the Notes pane.
  → spec `cutovers/daily-surface-consolidation-hard-cutover.md`
- **Reader sidecar 6 tabs → 2** — Highlights/apparatus/Connections are one idea
  rendered by three bureaucracies; embeds are inline now; chat opens a pane.
  → spec `cutovers/reader-sidecar-consolidation-hard-cutover.md`
- **Oracle loses its parallel-universe shell** — the theme scope travels; the
  route group doesn't need to.
  → spec `cutovers/oracle-shell-dissolution-hard-cutover.md`
- **Machine output leaves its drawers** — LI + Connections move into the
  surfaces they describe; co-author, not vending machine.
  → spec `cutovers/machine-output-in-place-hard-cutover.md`

## Declined

- **Resonance Digest** full-auto nightly web ingest — silent automation of
  corpus membership. Watchman/Expedition are the consented forms.
- **Marginalia heresy** (edges demoted to an index over prose) — the flat edge
  table stays sovereign; but steal the half-idea: Synapse rationales deserve to
  be read as prose, not compressed into "↳ 3".
- Streaks/badges anywhere. Ritual, not gamification.

## If only one thing

Machine Hand, then the stance sequence (Argument → Take a Side → Reckoning →
Ledger of Positions). Smallest path to the thing nobody ships — a system where
your reading argues with you, in a typography that never lies about who is
speaking — and every step is a clean hard cutover on substrate that already
exists.

## Provenance

Generated 2026-07-06 by a recon+ideation workflow (4 recon mappers, 14 lenses:
ambient-pulse, personal-canon, reader-instrument, oracle-ritual,
editorial-machine, ear, deep-time, maker, habitat, subtraction, heresies,
projections, worldgate, body). Curation and sequencing are editorial judgment,
not consensus.
