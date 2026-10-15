# preserve inspector sizing when composing the header changes

status: pending branch integration; isolated candidates remain unchanged
origin: 2026-10-15 independent source review; libraries `48897f9d5`, inspector `764b01b63` ([draft pr 617](https://github.com/NielsdaWheelz/nexus-web/pull/617))
area: shared pane header / branch composition

`SurfaceHeader.module.css` in libraries gives `.trailing .companion` and
`.trailing .primaryAction` a shared fixed 32px height. inspector replaces its
companion sizing with `--pane-control-size`, including a 44px coarse-pointer
target. retaining our shared height after composition defeats that target and
produces a 44×32px inspector button.

when combining, keep fixed 32px height on the primary action alone; preserve
inspector's size-variable/coarse rules. retain primary's ≤479px label hiding
and square width. preserve primary → more → inspector order, both primary
forwards through `PaneShell`, inspector's tooltip/native trigger and its
separate click-capture behavior. update the header comment for both controls.
the remaining contracts compose without an api change.

acceptance: integrated `./scripts/test` passes; desktop primary is 32px and
coarse inspector is 44×44px; narrow primary stays square; mobile controls and
both trigger/focus paths work. qualify the composed source before deleting this
ticket. source review did not merge or run the combined candidate.
