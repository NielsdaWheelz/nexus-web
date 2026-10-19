# chat details expansion can move the reading position

status: open integration requirement; no current inline reproduction
origin: 2026-10-16 chat details review; revalidated on main `48bc7fbad`
area: web / chat / scroll ownership

the merged viewer replaced the old inline report with a dialog; the earlier
inline bug is no longer reachable. restoring approved inline details must
account for `apps/web/src/components/chat/useChatScroll.ts:107-111,209-215`:
transcript growth can hold the bottom while following. its existing
`handle.inspectMessage(id, false)` releases following without moving the view.
it does not preserve a footer's position when live prose above it grows.

impact if integrated incorrectly: a long disclosure scrolls its trigger and
first rows out of view because inspection growth is treated as streamed content.

prerequisite: follow the details contract (#647).
keep one transient trigger/offset at the existing scroll owner, held through
prose growth and terminal replacement. manual scrolling or deliberate navigation
ends inspection. no second controller; collapse clamping must not resume follow.

reproduction to qualify: open an existing long chat or press latest, then expand
a long receipt at the bottom. repeat during generation and while reading older
messages, using pointer and keyboard.

acceptance: expansion/collapse keeps the trigger at a stable reading position
where physical scroll bounds permit;
inspection does not jump to the receipt's tail. ordinary stream following and
explicit latest still work. record browser evidence before calling this resolved.
