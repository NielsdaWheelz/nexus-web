# menu item casing is mixed

problem: one menu mixes sentence case and lowercase items. the media header
menu shows "Find", "Reader settings" and "Mark as finished" beside "metadata…",
"add to lectern" and "refresh source". one verb's own states disagree:
lectern membership reads "add to lectern" when absent and "Remove from
Lectern" when present.

impact: the menu looks assembled from parts, which it is; the casing reveals
each item's owner instead of its meaning. new verbs have no rule to follow.

evidence at branch `fork-gesture-pane-noun` (base `4a5b1c710`):
`apps/web/src/components/workspace/PaneShell.tsx:349` ("Find");
`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:103` ("Reader
settings"); `apps/web/src/lib/actions/catalog.ts:79` ("metadata…"), `:96-104`
("Mark as finished" and its states), `:108` ("Reset progress"), `:135-141`
("add to lectern" / "Remove from Lectern"), `:215` ("refresh source").

proposed fix: choose one menu-item case (desktop nexus and settings use
sentence case; mobile nexus deliberately lowercases), record it in
`docs/modules/visual-system.md`, and convert `ACTION_CATALOG` and the pane
command labels in one pass.

resolved when every item in the media header menu, and every state of each
catalog verb, uses the chosen case.
