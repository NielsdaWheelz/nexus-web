# the 60 kB pagehide budget of activity capture is proved only by reading

**problem**: on pagehide `lib/consumption/capture.tsx` (`leave`) hands queued
spans to the browser with `keepalive`, stopping before the bodies would pass
60 kB (browsers refuse keepalive bodies past 64 KiB in flight, which lost
whole batches before: D4). the live harness proves the pagehide path (W-CAP2:
spans held while the route was unreachable land after pagehide, within the
budget) but cannot reach the cap itself: about 200 queued spans need about half
an hour of observed time in one tab, and playwright does not report keepalive
bytes.

**impact**: low. a tab closed offline after more than ~200 spans of capture
loses the batches past the budget instead of every batch after the first.

**evidence**: `capture.tsx` `KEEPALIVE_BYTES`, `leave`; consume harness W-CAP2.

**resolved when**: a manual check (devtools offline for 35 min of reading,
then close the tab) shows keepalive requests totalling at most 60 kB and the
first batches stored, or the cap is covered by an automated check.
