# chat messages reserve space for hidden controls

status: open
origin: 2026-10-16 chat viewer design audit
area: web / chat / message layout

the transcript allocates multiple footer rows even when the reader cannot see
them. `ChatSurface.module.css:56-95` combines a `1.5em` message margin, wrapping
actions with block margins, and opacity-only hiding. `:112-120` gives the date
its own block and margins. user messages render actions and date separately
(`ChatSurface.tsx:200-207`); settled answers do the same
(`AssistantMessage.tsx:313-333`). `ChatComposer.module.css:81-84` makes the
collapsed regeneration picker a full-width flex item, separating it from the
overflow control. all paths are under `apps/web/src/components/chat/`.

impact: reading pays for several rows of controls per turn, including while
they are invisible. the structural diagnosis is independent of the pixel
total; the browser receipt below qualifies one sample.

browser receipt, 2026-10-16: read-only inspection of the existing deployed chat
`6c67a526-fa88-410d-bdf6-b6cd07071971` in the dark room, 611px pane / 571px
message width. `getBoundingClientRect()` gave user prompt bottom 337.19 and
assistant top 432.14: 94.95px separation. the assistant answer was 77.15px tall;
its footer occupied 165.86px from answer end to message end, before the 24px
message margin. the action block was 68px tall with opacity 0; the date was
18.95px tall with opacity 0. this qualifies that one deployed sample, not every
theme or candidate source revision.

prerequisites: agree the compact message-footer interaction contract. replace
the stacked footer at the chat owner; remove the candidate picker's full-row
claim when collapsed. keep a stable, bounded action area, visible focus and
touch access. retain recovery, source and branch semantics. do not shrink global
spacing or every overflow button to compensate.

acceptance: settled short user and assistant messages have one compact footer
at most; hovering/focusing/opening a menu neither moves the prose nor reveals
empty rows. regenerate is a named icon action with a tooltip. dates are
available without a permanent date row. touch controls remain reachable and
nonoverlapping, and 320px panes do not overflow.
