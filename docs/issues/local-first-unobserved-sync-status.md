# cold-reopen synchronization status needs live qualification

the earlier initializer allegation is resolved in source:
`apps/web/src/lib/authored/sync.ts:24` initializes `Sync.facts.head` to `null`.
do not count this as a current source defect or infer live behavior from that
initializer alone.

prove a fresh-process reopen of a completed local corpus cannot publish current
before registration or pull establishes the remote head. observe its initial
status while the real transport is held, then the offline failure or real head;
retain writing availability. fold this into the remaining cold-launch campaign.
