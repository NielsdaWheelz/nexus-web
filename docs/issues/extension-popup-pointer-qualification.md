# qualify pointer input in the capture popup

actual pointer scrolling and activation in the small firefox capture popup remain
unrun. no product pointer defect is established. native keyboard scrolling,
retry, deliberate tuck and restore are qualified at `cd7d935bb`.

after discarding a capture, an unanswered disconnection leaves a held notice in
a content-sized 360×66 popup. its reason requires native scrolling. the temporary
webdriver probe sent intended popup-local `(26,32)` wheel input as trusted popup
client `(987,113)`; using local coordinates instead reached browser chrome.
these observations establish an input-delivery limitation, not inert scrolling.

owners: `apps/web/src/extension/popup.tsx` and the native firefox qualification
caller of `python/scripts/lab_firefox.py`. establish the actual popup input
context before interpreting pointer results.

resolved when ordinary pointer input in the actual extension exposes the complete
reason, activates retry, and tucks/restores the same unanswered command on the
current build. record actual delivery and outcome; do not substitute javascript
clicks, forced scrolling, changed popup geometry or keyboard input for that proof.
