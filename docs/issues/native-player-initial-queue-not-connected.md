# native player initial queue connection

an isolated phone launch after real password handoff and successful catalog save
opened lectern with 29 rows, then reported “the native player is not connected.
reload the app.” playback connectivity was not established; catalog browsing
must not be mistaken for playback qualification.

evidence: qualification run `20261023-155201-8d2beb12e3cf`, source `2559e5f57`
plus frozen offline-catalog integration; private
`artifacts/playwright/offline-catalog-zphone-pho-d08df-ves-cold-offline-navigation/trace.zip`,
`2-trace.trace` frame snapshot `xvxp@3807`, and `artifacts/native-failure.png`.
the preceding baseline did not exercise native player startup.

owners: `lib/player/nativeEngine.ts:328` sends an asynchronous hello and ignores
its failure; `:240` also maps a missing queue snapshot to `NotConnected`;
`:250` supplies this message. native `playback/PlayerBridge.kt:104` and
`playback/NexusPlaybackService.kt:433-441` can refuse an unbound connection.
the native player bridge and these player owners are unchanged by the catalog
implementation. catalog uses the separate `nexusApp` protocol. causality remains
unresolved; do not broaden the catalog change without evidence.

resolve by capturing the initial `nexusQueueSession` hello/queue replies and
service/controller lifecycle, identifying whether binding or snapshot arrival
failed, then verifying fresh sign-in and cold native player connection.
