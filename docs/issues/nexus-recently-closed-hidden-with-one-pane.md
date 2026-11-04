# recently closed panes disappear with one open pane

problem: close one of two desktop panes, then open the blank nexus palette.
the closed pane cannot be recovered there: recently closed is absent when only
the active pane remains.

evidence: `lib/nexus/rows.ts:427,433` omits the empty `Open` group after placing
the active pane in `Here`; `components/nexus/desktop/DesktopNexus.tsx:342` renders
`NexusClosedPanes` only inside `Open`. both mechanisms are unchanged from main
`af406ccda`. the glyph merge's c8 lab at `7bd6e24dc` reproduced this in chromium
and firefox: close chats beside All, open nexus, and only here/actions remain.
paths are under `apps/web/src/`.

fix at the palette's grouping/presentation boundary: closed-pane recovery must
not depend on another open pane. resolved when a closed pane can be reopened
from the blank palette with only the active pane left, in both browsers.
