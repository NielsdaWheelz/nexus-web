# nexus menu close reclaims focus unconditionally

status: open; source-confirmed focus policy, browser qualification pending
origin: 2026-10-16 principal-actions specification review
area: web / desktop nexus / menu dismissal

`apps/web/src/components/nexus/desktop/DesktopNexus.tsx:54-61` schedules focus
on the search input whenever a row menu closes. the callback at `:199` receives
only open/closed state. it cannot distinguish escape from outside press or a
command opening another surface. `components/ui/ActionMenu.tsx:118,127-130`
deliberately avoids return focus for outside dismissal; the nexus callback
overrides that decision on the next frame. it would also undo directional tab
exit when the shared menu is corrected. no live focus race was reproduced here.

prerequisite: keep one owner of dismissal focus. let the menu accept the nexus
input as its explicit invocation/return context for this composite, retaining
the row button as its geometry anchor. remove the unconditional delayed focus
from the open-state observer. tab continues from that context within the modal;
escape returns to it; outside dismissal and navigation do not reclaim focus.

acceptance: in desktop nexus, escape returns to the search input, tab/shift-tab
exit the menu in the correct modal order, and clicking another focusable control
keeps that focus. opening a dialog or navigating from a menu leaves focus with
the new owner. verify the outcome again after animation frames and delayed
resource-menu completion; no callback restores obsolete focus.
