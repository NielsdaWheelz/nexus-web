# player queue writes absolute scroll offsets

status: open; source review, momentum effect unmeasured in the queue.

`apps/web/src/components/player/useQueueWindow.ts` still uses `scrollTop +=` for
anchor compensation. that reads a main-thread offset then writes an absolute
position; the reader's firefox smooth-scroll lab proved that the equivalent
operation cancels a scroll. a compositor race in the queue is inferred.

connections-scroll shares the frame scheduler but deliberately leaves these writes
unchanged. its a14 proves no sampled blank frame, not uninterrupted momentum.

resolved when queue compensation uses the correct relative primitive and a queue
height-change case preserves smooth travel and anchor offset in firefox.
