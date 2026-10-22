# library chooser uses a plural noun for one selection

`apps/web/src/lib/libraries/placementController.tsx:304` always renders
`<count> libraries selected`. the podcast placement editor shows “1 libraries
selected” for one filed destination; membership and commands still work.

observed in the real desktop and handset placement editor during the
2026-10-21 pane-controls review, against `bed9ea1b0`.

resolve in the shared placement summary with the existing pluralization
primitive. verify zero, one and multiple selected destinations use the right
noun without changing selection or placement behavior.
