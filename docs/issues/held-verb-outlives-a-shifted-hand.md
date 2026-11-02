# a pressed slip verb stays held after the hand has left it

status: open
origin: 2026-11-02 feedback-homes l3 lab probe
area: web / feedback / VerbControl

`VerbControl` (`components/feedback/Fact.tsx:23-41`) keeps the verb that was under the pointer
or focus until both leave, and shows it blocked with `this action is no longer available`
when the owner swaps the verb. after a press whose answer reflows the slip, the button moves
out from under a still pointer. the browser fires `mouseleave` on the button, but
`onMouseLeave` never reaches `hold("pointer", false)`. so `pointer` stays true, and the stale
verb outlives the pointer's departure and focus leaving.

impact: a held chat send whose retry a stale build refuses says `not sure your message sent.
nexus updated.`, but the slip keeps a dead, blocked `retry` in place of `reload` until the
pointer enters that control again and leaves. any slip whose press swaps its verb behaves the
same way. a keyboard press is unaffected.

evidence, chromium, lab, at feedback-homes-l3 `f97c64565` with `hold` logged:
`hold pointer true`, `hold focus true`, then after the press native `mouseleave on BUTTON
related=SPAN`, but no `hold pointer false`. `page.mouse.move(0, 0)` adds no events, and blur
logs `hold focus false ... flags={"pointer":true,"focus":true}`. the frame still renders
`retry` with `this action is no longer available` after focus moved to the composer. probe
source: scratchpad `build/l3-r4-probe.keep.ts`, logs `l3-r4-probe3.log`, `l3-r4-probe4.log`.
firefox shows the same blocked `retry` in the l3 journey (`l3-r4-green1.log`). the cause
inside react's enter/leave dispatch is not established.

reproduce: hold a chat send unknown (abort `POST /api/chat-runs`), answer the next post with
426 `E_WIRE_MISMATCH`, press the slip's `retry` with a mouse, and leave the pointer still.

resolved when: once the pointer and focus have left a pressed verb whose owner replaced it,
the replacement shows without the pointer having to re-enter, in chromium and firefox.
