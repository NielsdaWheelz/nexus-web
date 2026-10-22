# native conflict action cannot be activated

run18 (`2808a6124`, lab `20261021-173813-e9aef096df90`) reached the real
foreign-update conflict with original a, local b and saved c retained. the
Samsung driver then could not click `use saved version`: Playwright reported
the comparison `dd` or `dl` intercepting pointer events. the failure is recorded
in `artifacts/writing-device/report.json` at `qualifyForeignComposition`.

the trace does not yet distinguish actual comparison overflow from keyboard /
visual-viewport click coordinate mismatch. no failure screenshot or hit geometry
was retained. capture the actual button/client rectangles, visual viewport,
hit-test result and screenshot at the failed activation before changing css.

resolved when the real native conflict journey can activate the actual visible
decision and preserve the required rich comparison and writing outcome.
