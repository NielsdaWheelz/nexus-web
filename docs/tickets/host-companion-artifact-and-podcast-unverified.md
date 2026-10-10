# artifact find results and podcast Inspector are not driven live

status: open · origin: 2026-10-10 workspace host reauthor (cleanup/workspace-host-reauthor), c2wh harness H-S4 · area: workspace / verification

design §13 H-S4 asks that the Inspector exists on podcast detail and not on an
artifact, and that an artifact's Find → Results opens a solo "Search results"
column (desktop) and sheet (mobile) with no tablist. the c2wh stack has no
podcast (no feed fixture) and no artifact (a dossier needs generation), so
H-S4 covers media, library, page, note, author, conversation, imports,
libraries, search and settings only. by construction `Companion` renders a solo
title when the pane publishes no Companion (`ArtifactPaneBody` publishes none)
and `PodcastDetailPaneBody` publishes one through `useResourceInspector`.

what to do: add a podcast and an artifact fixture to a harness stack (a local
feed file; an artifact written through its producer without a model), then
drive both cases.

acceptance: H-S4 covers podcast detail and the artifact solo results column and
sheet, all passing.
