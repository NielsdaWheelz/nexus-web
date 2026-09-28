# stats timeline modalities are indistinct in forced colors

status: open · origin: 2026-09-28, size/consumption-stats reauthoring · area: consumption / stats pane / accessibility · p3

the old timeline hatched Listening and Viewing bars with svg patterns. the
reauthored one draws each modality as a flat-coloured `rect`
(`StatsPaneBody.tsx:233`, classes `barReading`/`barListening`/`barViewing`), and
`@media (forced-colors: active)` paints every `.chart rect` `CanvasText`
(`StatsPaneBody.module.css:278`). in windows high contrast the stacked bars read
as one colour.

impact: small. the chart is `aria-hidden` and the per-bucket table carries the
same numbers; only a sighted forced-colors reader loses the modality split at a
glance.

fix: under forced colors give Listening and Viewing a distinct system-colour
treatment (a `stroke` in `CanvasText` over `Canvas` fill, or one small shared
pattern), not three new svg defs.

acceptance: in chromium with forced colors emulated, the three modalities of a
stacked bar are distinguishable.
