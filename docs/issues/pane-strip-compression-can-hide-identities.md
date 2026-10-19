# pane strip compression can hide identities

status: open · origin: 2026-10-16 pane tabs design review · area: web / workspace layout

problem: the strip permits pane identities to shrink away while preserving
each pane's two action buttons. its overflow container has no usable tab-width
floor to make additional panes scroll instead of compressing their names.

evidence: `apps/web/src/components/workspace/WorkspacePaneStrip.module.css:24`
sets each tab to `min-width: 0`, followed by `flex: 0 1 auto` and clipped
overflow. the activator and title also have zero minimum widths (lines 39 and
57), while actions cannot shrink (line 128) and reserve two 24px targets
(`apps/web/src/app/globals.css:80`). this permits blank or nearly blank
identities at the supported twelve-pane limit. this is a source-level layout
hazard; the exact failing viewport has not been browser-measured.

prerequisites: choose the strip's visible action set and a readable tab-width
floor. retain stable control positions and full accessible names.

proposed fix: preserve enough width for recognizable pane titles, allow the
strip to scroll beyond that floor, and reveal the active or keyboard-focused
item without scrolling the canvas. verify coarse-pointer target geometry too.

acceptance: at twelve panes, narrow desktop widths and enlarged text, every
pane remains identifiable and reachable; controls do not clip or cover labels.
activation, keyboard focus and drag reordering reveal the intended item, and
the canvas does not jump when only strip navigation occurs.
