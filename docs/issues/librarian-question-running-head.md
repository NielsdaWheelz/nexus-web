# a long answer loses sight of its question

status: open · follow-up recorded during the 2026-11-12 leaves design; not built · area: web / librarian transcript

once a long answer scrolls its question off the top, nothing on the pane says
which question is being answered. a sticky or condensed heading would, and was
declined for the leaves build.

why it was declined: `useChatScroll` pins a new question by its root's `offsetTop`
and holds a reading point by text rectangles
(`apps/web/src/components/chat/useChatScroll.ts:85-137,265-269`). a sticky heading
moves those rectangles without scrolling, and a long question would hold most of a
short pane.

a workable shape: a one-line running head owned by the scroll owner, drawn from
the leaf whose answer crosses the top inset, hidden while that leaf's own heading
is on screen, absent from pane find and from the text cursor. it needs its own
decision on phone height.

resolved when a reader at any point of a long answer can see its question without
scrolling, and pin, reading-point and margin continuity still pass.
