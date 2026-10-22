# a fresh passage note requires three sequential round trips

status: open · origin: owner source audit, 2026-10-21 · area: reader selection composer (`app/(authenticated)/media/[id]/useSelectionComposer.ts`)

problem: saving text on a new passage creates its highlight, reads that highlight
again, and only then writes the note. the composer stays in its save operation through
the whole chain. the reread is a direct fetch outside the tab write queue; the two
writes each wait their turn in it.

evidence (source at `2e154f053`; no timings measured):
- `apps/web/src/app/(authenticated)/media/[id]/useSelectionComposer.ts:335-343` awaits
  highlight creation; `:378` rereads it (`liveHighlight`, `:59-64`) although the create
  reply already carries the highlight and its `links_version`; `:385-402` awaits the note
  `PUT`, whose `absent` expectation uses the reread's `links_version`; only `:418` ends
  the operation.
- each highlight acknowledgement rereads the document map
  (`media/[id]/annotations.ts:206-210`, reached from `:339` and `:412`), and the note
  acknowledgement publishes `Notes` (`:399`).
- `docs/modules/highlight.md:203-204`: ensure and note save are separate commits, so a
  refused note can leave a highlight without the submitted note. that partial result is
  documented behaviour; this record concerns the interaction cost.

impact: acknowledgement latency is three network round trips plus queue waits.

fix: let one domain command take the frozen passage, client identities, body and
explicit observed preconditions, publish highlight and note atomically, and return the
canonical acknowledgement for the shared owners to reuse; keep the empty-body and
conflict semantics. if the separate commits stay, first prove which intervening read is
required and remove only redundant ones without refreshing away the caller's fence.

resolved when a fresh passage note reaches a truthful saved state through one command
and acknowledgement, or a justified smaller path, with retries, generation conflicts,
successor typing and late focus behaviour still correct.
