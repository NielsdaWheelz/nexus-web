# deployed transcript reader qualification

production source `400e7039e` is deployed at schema `0312`, wire `14`, paired with
signed android `0.3.6` (code `26`). migration `0311` preserved chapter facts and
ids; historical null ends remain unverified until a new publisher observation
confirms absence. the [queue release](release-playback-queue.md) records the
limited unsent-playback waiver and observed old-app refusal.

`nexusQueueSession` is the sole player bridge. unloaded or ended timestamp starts
require fresh server state; loaded seeking remains available offline.

remaining activated-build journeys are `NOT_RUN`: loaded offline seeking, fresh
unloaded timestamp starts and stale-command ordering. prior local browser and
emulator results do not establish these production or physical-device boundaries.

resolve after those journeys pass or receive an explicit owner disposition;
record proof in the release pr. permanent contracts live in the
[player](../modules/player.md) and [reader](../modules/reader-implementation.md) modules.
