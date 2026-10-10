# the selection dock does not follow its selection through a scroll

status: open · origin: 2026-10-10 overlay kernel reauthor (cleanup/overlay-kernel-reauthor), overlay harness D8 · area: web / reader, chat

the reader's selection dock (`app/(authenticated)/media/[id]/SelectionDock.tsx`)
anchors to `capture.rect`, a `DOMRect` the text surface takes once per
`selectionchange` (`lib/documentReader/text/TextSurface.tsx`, `geometry.ts`
`range.getBoundingClientRect()`). scrolling the reader moves the selection but
fires no `selectionchange` (probed: none on wheel scroll in chromium, firefox or
webkit), so the floating surface re-measures against the stale rect and stays
where the selection was. the chat answer's selection surface
(`components/chat/AssistantMessage.tsx`, `passage.rect`/`passage.lines`) has the
same shape. `useAnchoredPosition` re-measures on every scroll; its anchor is
what is stale.

the overlay harness's `J7.selection-dock-follows-scroll` waits for the wheel
scroll to move the selection, then finds the dock where the selection was, on
chromium, firefox and webkit (XFAIL on all three).

impact: select text, scroll with the wheel or a finger: the dock hangs where the
selection was, detached from it, until the selection changes.

what to do: give the surface a live anchor. either the capture owner re-captures
on its scrollport's scroll (the reader already measures there), or the
selection surfaces anchor to the live selection range (`getBoundingClientRect`,
`getClientRects` at measure time) with the captured rects as the fallback once
the selection collapses.

resolved when: `J7.selection-dock-follows-scroll` passes on chromium, firefox
and webkit.
