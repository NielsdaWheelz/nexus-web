# chat-answer selection uses frozen geometry

status: open · origin: 2026-10-10 overlay reauthor, narrowed 2026-10-15 selection composer · area: chat

`components/chat/AssistantMessage.tsx` retains `passage.rect`/`passage.lines`
from selection capture. scrolling moves the selected prose without firing
`selectionchange`; the floating surface measures stale rectangles. original
harness `J7.selection-dock-follows-scroll` reproduced this on chromium,
firefox and webkit.

the hosted reader portion is fixed: canonical source coordinates and live
measurement follow scroll/reflow/pdf zoom, with offscreen pinning. see
reader qualification: #631.

fix: give chat-answer selection its own stable source identity and live
measurement through the existing floating-surface measured-anchor contract.
never retain stale rectangles as geometry after selection collapse.

acceptance: select assistant prose, scroll/reflow its pane and enter the
surface; it follows the current source and stays within its pane on chromium,
firefox and webkit without losing the captured passage.
