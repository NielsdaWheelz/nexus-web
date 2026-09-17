# mobile navigation may retain the prior pane

status: open
origin: 2026-09-14 highlight popup session; updated 2026-09-17
area: workspace navigation

former journey run `18b20381b30bf394` on
`6c9e8a89e4a183f774500bf0f2988fc327ed50f2` requested a media reader but its
failure capture showed the prior browse pane and its generic more button.
`apps/web/e2e/fixtures.ts:174` did not await the requested pane. the unchanged
candidate passed diagnostic replay `95c975cf43007f23`; base
`7fa89b88c8342bca9edfb46a6d20053c49555fb2` passed run `6bef0f2004207fdd`.
these are historical observations; the journey and local artifacts are removed.

prerequisite: distinguish an actual workspace restoration defect from the
removed journey's readiness race. manually navigate from mobile browse results
to the requested reader and inspect the pane and resource action menu. inspect
restoration only if the wrong pane persists during ordinary use.

acceptance: the requested reader and its menu appear correctly in manual use,
or a reproduced restoration defect is repaired. no journey reconstruction is
required.
