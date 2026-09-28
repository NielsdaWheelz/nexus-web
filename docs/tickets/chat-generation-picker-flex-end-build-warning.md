# generation picker emits flex alignment build warning

status: open
origin: 2026-09-25 article-section-navigation integrated frontend build
area: chat layout / frontend build

the isolated `npm run build` at `c128792460ee07672721227781b13981cb823581`
completed but autoprefixer warned twice that `end` has mixed support at
`apps/web/src/components/chat/GenerationSelectionPicker.module.css:4:3` and
suggested `flex-end`. webpack also could not serialize the warning in its cache.
the section-navigation change does not touch this file. the visible layout
impact has not been checked.

prerequisite: inspect the picker's flex layout and supported browsers. use the
alignment value whose semantics match that layout, then check the picker in
the affected browsers and confirm a clean production build.

acceptance: the picker aligns as intended and the production build emits no
alignment or derived cache warning.
