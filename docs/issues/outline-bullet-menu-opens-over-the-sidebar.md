# the leading outline menu opens over the sidebar

reported in a desktop lab at `839bb918b` on 2026-11-16; its photograph was not
retained. clicking or right-clicking a standalone note's outline bullet opened
the menu leftward over the navigation sidebar.

source agrees with the placement: `apps/web/src/components/notes/OutlineEditorRow.tsx:116`
passes no alignment to `ContextualActionMenu`. `ActionMenu.tsx` defaults to
`align="end"`; `apps/web/src/lib/ui/useAnchoredPosition.ts` aligns the menu's
right edge to the anchor's right edge. that suits a trailing trigger, but this
bullet is a leading trigger.

impact: the menu appears detached from its row and hides unrelated navigation.
use the existing placement owner's leading-anchor alignment; whether pane
bounds also need to constrain it remains unverified.

resolved when: the bullet menu stays associated with its row and reachable at
narrow desktop widths without covering the sidebar.
