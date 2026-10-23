# offline reader positioning notice

status: investigating
origin: 2026-10-16 book-repair consumer qualification
area: android / document reader

the installed 0.3.2/code22 old offline copy of media
`13c144cd-fdf6-44fa-8033-ef4077d1d378` showed “couldn't open that passage.”
after ordinary reading swipes. downloads subsequently showed “position saved
on this device”. loss of the saved passage has not been established.

evidence: runtime `fdd0a3e`, old package `g2`, server publication `g3`;
campaign `coordinator/finalfdd0a3e/live-reader-consumer-v1/nav13-old-conflict-v1/`
retains the initial/open/controlled/pending-shelf xml, screenshots and actions.
the initial open xml had no notice; the controlled xml had two accessible
copies of it. `DocumentReader.tsx:256-258` maps both `TargetUnavailable` and
`PositioningFailed` to this text; the actual cause remains unproved.

first finish the admitted no-input reopen observation without discarding the
test copy or pending position. identify the responsible navigation transition
before changing code. preserve the old-copy refusal evidence separately.

2026-10-23: `a668a1f71` repairs shared failure acknowledgement, distinguishes
layout preservation from opening, and defers unmeasurable pane reflow. desktop
hide/show and current downloaded text/pdf readers were qualified. this establishes
a separate desktop producer and repairs feedback ownership; it does not establish
the original installed old-copy swipe trigger. that copy and its pending position
were outside this change.

resolved when the cause is established and ordinary offline reading and
no-input reopening retain the intended passage without a spurious failure;
record the actual consumer result and remove this ticket if corrected.
