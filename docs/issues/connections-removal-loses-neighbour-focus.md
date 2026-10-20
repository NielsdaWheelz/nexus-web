# removing a link from a row loses focus to the page body

status: open; reproduced, cause unconfirmed · origin: resource references re-slice port onto main, 2026-10-19 · area: resource rows / connections (web)

choosing "remove link from both items; keep their notes" from a Connections row's menu
removes the link, and the row's removal focuses the next row's control as designed
(`components/resources/ResourceOutlineRow.tsx`, the `remove` neighbour step), but focus
leaves that control for the page body a few milliseconds later. the refs harness journey
`refs/J6.remove-link-moves-focus-to-a-neighbour` logs it (`state/j6-focus-log.txt`):
`202 focusin BUTTON[Expand linked resources for Refs Unlink Target 1] | 206 focusout
BUTTON[…Refs Unlink Target 1]` with no related target. it passed at `d6b73c712` (the
removal was `DELETE /resource-graph/links/{id}`); it fails on every port onto main since
#683 moved the removal into the tab's write queue (`unlink` graph command, then
`publishChange("Notes")` and the link announcement), and it fails the same way with
main `2f9cb0a1a`'s own web build against the re-slice's api
(`refs/harness/state/ab-main-web-j6.txt`), so it is main's behaviour, not the port's. since #690
(`0c6da7f32`, which rewrote the removal and its focus fallback; the port keeps that path verbatim)
no neighbour takes focus at all: the chosen menu item leaves the document and focus stays on the
body, while the hud shows the removal's success receipt "link removed; notes kept"
(`port-8-targeted.txt`), so the success path ran and its neighbour focus step found no connected
target or was skipped.

impact: a keyboard user who removes a link loses their place; the next Tab starts from
the top of the document.

resolved when: the journey passes (it is XFAIL with this defect; the journey's focus log
names whether the control was removed, disabled or made inert).
