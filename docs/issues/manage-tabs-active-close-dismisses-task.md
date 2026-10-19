# closing the active tab dismisses manage tabs

status: open
origin: 2026-10-16 pane interaction design audit
area: web / workspace / nexus

problem: manage tabs promises close-in-place, but closing the active pane exits
the task. closing an inactive pane stays open, so the same close control has
different effects depending on workspace selection.

evidence: `docs/modules/panes-tabs.md:94-99` specifies closing without
dismissing. `apps/web/src/components/nexus/useNexusController.ts:495` forwards
close directly to the workspace; `:103-109` dismisses nexus when the active
pane or visit changes. `apps/web/src/lib/workspace/store.tsx:400-411` changes
the active pane when it closes. this is source-derived; no browser run was
performed in this review.

prerequisite: keep navigation from external commands able to dismiss nexus.
fix: let manage tabs own its close action and absorb that action's workspace
selection change, keeping the page open and moving focus to a surviving row.

acceptance: close inactive, active, and final panes from manage tabs; the task
stays open with usable focus and updated open/recently-closed rows. deliberate
tab activation and external navigation still dismiss it.
