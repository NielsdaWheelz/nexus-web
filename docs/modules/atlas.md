# atlas

status: reauthored (cleanup/atlas-share-reauthor) · 2026-10-14

purpose: a celestial chart of the viewer's library. one star per work they hold,
placed by meaning in one global frame, grouped into constellations by library,
linked by discovery and contradiction edges, with the oracle's readings as a
second layer.

## one frame (sole writer)

`services/atlas.py` owns `media_atlas_positions (media_id, x, y ∈ [0,1])`. The
periodic `atlas_project_job` (`ATLAS_PROJECT_SCHEDULE_SECONDS`, prod 86400) is its
only writer; nothing enqueues it on demand. One sweep reads the mean active-model
embedding (`avg(...)::real[]`) of every media filed in any non-system library,
runs a numpy power-iteration PCA (component 1 from the axis e0, component 2 from
e1 re-orthogonalized against component 1 every step, 20 steps each), min-max
normalizes to [0, 1], applies one repulsion pass (gap 0.02), deletes positions
outside the frame and upserts the rest, all in one transaction: a retry
recomputes the whole frame (idempotent). Fewer than three vectors take fixed
spots. New media wait unpositioned (the nebula) until the next sweep.

## read model

`GET /atlas` → `Data[AtlasOut]`, one read and one picture: it is exempt from
keyset pagination because the sky cannot be drawn in pages.

- stars: the viewer's personal relation (every visible media of their
  non-system memberships), never corpus works: `media_id`, nullable `x`/`y`,
  `title`, `kind`, `magnitude` (the viewer's highlight count).
- constellations: one per non-system membership, empty ones omitted; members
  are `library_media_ids_cte_sql` for that library, so the viewer's Default is
  "All" and holds every star.
- edges: the viewer's discovery-context and contradicts edges between two of
  their stars (`source_media_id`, `target_media_id`, `kind`); an edge that targets
  an evidence span stands for its media.

## sky

`atlas/sky.ts` is geometry and paint: a planisphere maps (x, y) to polar
coordinates about the zenith; the nebula sits on the rim; folios sit on an arc
by a hash of their theme. `atlas/SkyCanvas.tsx` hosts the canvas: scene in, hover
and pick out. It draws only while its pane is visible; under reduced motion it
draws once per change (scene, resize, drag) and never turns on its own.
`GrandAtlasPaneBody.tsx` reads the sky (`useServerValue`, visit `Atlas.Sky`),
the readings when that layer is on and a selected folio's concordance; a work
opens in the pane, a folio's first pick traces its concordance and keeps its
label until the next pick (touch has no hover, so with a mouse too the label
stays after the pointer leaves), the second opens it. A failed read shows the
shared failure copy (`failureCopy`: transport copy, else "Something went wrong.
Try again." with the request id; it never throws on a modeled answer) with
Retry, which leaves focus on the headline. The screen-reader list mirrors the
visible layers and opens in the pane.
