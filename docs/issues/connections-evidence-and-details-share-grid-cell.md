# connections evidence and details share a grid cell

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation audit
area: connections / shared resource row

an unwrapped resource row assigns its evidence and expanded details to the
same full-width grid cell. connection rows can populate both, so excerpt text
and creation, dismissal or link-note details compete for the same space at
desktop row widths.

evidence: `apps/web/src/components/ui/ResourceRow.module.css:147-151` places
evidence at row 3, columns 1 through -1; `:184-186` gives expanded details the
same placement. `apps/web/src/components/connections/ConnectionsSurface.tsx:176-194`
passes evidence and expanded details together without `wrapped`. the wrapped
override at `ResourceRow.module.css:196-201` does not apply. this is a source
audit; no browser reproduction was run.

reproduction: show a discovery connection with an excerpt and dismissal
details, or an assistant connection with both excerpt and creation provenance,
in a connections surface wider than 520px.

prerequisite: the shared row must give simultaneous evidence and details
distinct flow positions. fix their placement at that owner, or remove the
conflicting slots as part of the shared resource presentation redesign.

acceptance: excerpt, creation provenance and link-note details remain legible
without overlap at desktop and narrow widths, including rows with all fields
present.
