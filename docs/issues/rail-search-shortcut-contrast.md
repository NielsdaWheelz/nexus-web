# the rail's Search shortcut hint fails text contrast

problem: the expanded rail's `⌘K` / `Ctrl K` hint on the Search command is
`--ink-faint` on `--surface-2` at 12 px: axe measures 3.4:1 in the default dark
theme (`#6f6f76` on `#1c1c1f`), under the 4.5:1 that WCAG 1.4.3 asks of small
text.

impact: low-vision users may not read the shortcut; the command's own label and
`aria-keyshortcuts` are unaffected.

evidence: `apps/web/src/components/appnav/AppNav.module.css` `.commandKbd`
(`color: var(--ink-faint)`), unchanged since before the pane chrome re-slice;
axe `color-contrast` on `/libraries` at 1400×900 (pane chrome harness A-1,
2026-10-21, which records it as known).

resolved when axe reports no `color-contrast` violation on the rail's hint in
every theme, and A-1 drops its known exception.
