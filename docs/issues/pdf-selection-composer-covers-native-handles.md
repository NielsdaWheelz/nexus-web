# pdf annotation composer can obstruct native selection

in [attention is all you need](https://arxiv.org/pdf/1706.03762), v7,
on the samsung sm-s906w, android 16 / webview 155.0.8059.43, long-pressing
“dominant” in the first-page abstract places the annotation composer over
the selected word. android handles remain above the note editor; dragging
the right handle through that area collapses the selection (8 characters to
0). selecting an unobstructed word and dragging its handle succeeds (8 to
173 characters). chrome remains hidden throughout both cases.

reproduction: a 360 × 780 css-pixel viewport; hide reader controls; long-press
the word near (114, 427). native evidence on 2026-10-19 distinguished handle
input from dom pointer input. the placement owner is
`SelectionDock.tsx:116` (`FloatingActionSurface`, `strategy="text-selection"`)
under `apps/web/src/app/(authenticated)/media/[id]/`.

resolve when: selection and both native handles remain usable at central
and boundary positions with the composer open. determine the placement/input
cause before changing shared floating-surface behavior.
