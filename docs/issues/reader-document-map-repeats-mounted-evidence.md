# alter's document map repeats evidence the mounted reader already has

current main `5a1ca39e2` serializes 25,685,462 bytes for the document map of
alter's hebrew bible. 7,051,680 bytes are unused root placement fields and
3,448,045 bytes are source-reference ticks the reader builds from its mounted
epub text, across 12,040 owners. the measured output on the same installed
book falls to 15,185,737 bytes. every other field and value matches. private
measurements are `integration-current-main/alter-map-exact-size-comparison.json`
and `integration-current-main/repair-and-map-1ba95fbf2-r2/alter/main-map.json`.

`8664604a6` removes both. the paired wire 26 candidate `8e22d112` includes
that change. chromium and firefox still draw the epub tick, open the complete
source note, and hold the saved place. mounted epub ranges own source-reference ticks. the issue closes
when the paired clients and api ship with these deletions.
