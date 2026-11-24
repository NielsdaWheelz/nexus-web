# outline shortcut placement on the affected android handset

on 2026-11-24 the owner reported the installed app putting all six outline
commands above the nexus button while typing. at `d77bffa5c1`,
`PaneShell.tsx:249-258` used the content clearance that already included
the button. the 48 css px target and 12 css px gap raised the entire row.
the [workspace viewport](../modules/workspace.md#mobile-viewport-and-bottom-geometry)
now places the row first. lab `20261124-042220-4db1e96eaa5e` passed the
sequence below on a pixel 6 emulator with android 15, webview 124 and gboard
at `956e251e1`. the affected handset and installed build are unverified.

resolve under a [coordinated handset lease](release-mobile-editor.md). tap the
last of two sibling outline items. the docked keyboard should meet the command
row and nexus should sit 12 css px above it. indent and undo the item and type at
the original caret. open nexus once with one tap, then check the player, row
and nexus order after selecting a block and dismissing the keyboard. at a plain
caret, dismissal should withdraw the row and leave the last line reachable.
record the handset, build, keyboard and observed positions.
