# mobile nexus search progress is invisible

status: open; source-confirmed, live reproduction pending.
origin: 2026-10-16 mobile command palette design review.
area: nexus / mobile search feedback.

problem: `apps/web/src/components/switchboard/SwitchboardTask.tsx:123` exposes
busy state only through `aria-busy`; its `Searching…` message is inside the
screen-reader-only status at lines 171–178. no visible progress element is
rendered, although `apps/web/src/lib/nexus/useNexusFind.ts:81–89` already owns a
150ms delayed busy signal. empty-result copy is withheld while pending.

impact: slow retrieval looks complete or inert while immediate query actions
are already actionable.

reproduce: delay real openables/owned-search responses, type a query, and inspect
the visible surface before responses settle. source inspection establishes the
missing visual status; no delay experiment was run in this review.

prerequisites: none. proposed fix: project the existing busy state as compact,
visible feedback without hiding successful results or moving selected rows;
keep source-specific retry and distinguish pending from settled empty results.

acceptance: delayed search has visible and announced progress; fast searches do
not flash unnecessary feedback; partial failure retains results with retry;
settled empty state appears only after relevant work settles.
