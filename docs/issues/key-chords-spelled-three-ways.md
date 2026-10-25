# key chords are spelled three ways

problem: user-facing copy spells the same chord three ways: "shift-enter"
(hyphen, lowercase), "shift+enter" (plus, lowercase) and "Shift+Enter" (plus,
capitalised). the fork chord alone appears in all three, sometimes on one
screen.

impact: no reader-facing defect beyond inconsistency, but there is no rule for
new copy, so every edit picks one at random and help text reads as if written
by three hands.

evidence at branch `fork-gesture-pane-noun` (base `4a5b1c710`):
- "shift-enter": `apps/web/src/lib/shortcuts.ts:31` (`NEW_PANE_HINT`, the
  header history and strip chip tooltips);
  `apps/web/src/app/(authenticated)/media/[id]/SelectionDock.tsx:384` and `:388`.
- "shift+enter": `apps/web/src/components/nexus/desktop/DesktopNexus.tsx:127`
  (nexus help), `apps/web/src/lib/shortcuts.ts:33` (`PANE_STRIP_DESCRIPTION`,
  with "shift+m"); `DesktopNexus.tsx:243` also says "shift plus enter".
- "Shift+Enter": `apps/web/src/components/find/FindBar.tsx:150` (find bar
  tooltip), `apps/web/src/lib/shortcuts.ts:52` and
  `apps/web/src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx:36`
  (keybindings).

proposed fix: choose one written form (the keybindings page's "Shift+Enter"
matches `formatShortcut` and `aria-keyshortcuts`), state it in
`docs/modules/visual-system.md` or the shortcut owner, and convert the copy
above. spoken-only text ("shift plus enter") may stay spelled out.

resolved when `git grep -i "shift-enter\|shift+enter"` over `apps/web/src`
user-facing strings returns one form.
