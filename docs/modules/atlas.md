# atlas

status: reauthored with the oracle (cleanup/oracle-reauthor) · 2026-10-04

## one frame

`services/atlas.py` owns `media_atlas_positions` (media_id, x, y ∈ [0,1]). The
periodic `atlas_project_job` (`ATLAS_PROJECT_SCHEDULE_SECONDS`) recomputes one
global frame: the mean of each media's embeddings under the active model, for
media filed in any non-system library; one pure-python power-iteration PCA (axis
seeds e0, e1; component 2 re-orthogonalized every step); min-max normalization;
one repulsion pass; upsert; positions outside the frame are deleted. Every viewer
sees a shared media at the same place. New media sit unpositioned (the nebula)
until the next sweep; there is no on-demand trigger.

## read model

`GET /atlas` is a typed route returning `Data[AtlasOut]`: stars (media_id,
nullable x/y, title, kind, the viewer's highlight count), constellations (one per
non-system membership, empty ones omitted, the viewer's default named `All`) and
edges (the viewer's synapse-context and contradicts edges between two of their
stars; a synapse edge that targets an evidence span stands for its media). Stars
come from the viewer's personal relation over non-system memberships, so corpus
works never become stars. There is no ETag: no consumer sent `If-None-Match`.

## sky

`atlas/sky.ts` draws the dome as a planisphere: (x, y) becomes polar coordinates
about the zenith, so the two ends of the principal axis face each other across
the dome. The nebula sits on the rim; folios on the readings layer are placed by
a hash of their theme. `GrandAtlasPaneBody.tsx` owns the loop (idle rotation
unless reduced motion), dragging, hover labels, the two layer toggles
(`?layer=readings` opens the readings layer), a folio's first tap tracing its
concordance and the second opening it, and the screen-reader list of stars.
