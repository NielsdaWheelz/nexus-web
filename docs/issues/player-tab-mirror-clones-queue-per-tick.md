# passive player tabs receive the full queue on engine notifications

`apps/web/src/lib/player/playerRuntime.tsx:635-647` publishes a browser snapshot
from the engine subscription. `browserOwnership.ts:74-80` posts the full queue
index with each state message, causing it to be structured-cloned to passive
tabs even when the queue has not changed.

the receiver now retains the queue manifest by queue id and revision
(`playerRuntime.tsx:593-601`), so the older claim that every notification replaces
its manifest identity is obsolete. transport cost for a large queue remains a
source finding; its frequency and visible performance impact are unmeasured.

profile an owning tab and a passive tab with a large queue. if material, publish
position separately and transmit unchanged queue content only when its revision
changes, through the existing ownership channel. resolve when the profile shows
that clock updates no longer repeatedly clone the unchanged queue while passive
playback controls and ownership transfer remain correct.
