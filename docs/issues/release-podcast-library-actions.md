# release podcast library actions

resource actions replace `AddPodcast`/`StopPodcast` with distinct
`SubscribePodcast`, `ImportPodcastEpisodes`, `UnsubscribePodcast` and
`RemovePodcastEpisodes` kinds. mixed api/web contracts are incompatible;
write endpoints and database schemas do not change.

production source `400e7039e` shipped wire `14`, as recorded by the release
records on fetched main `aa3dfc086`. this is the first incompatible change in
this checkout since that release: `python/nexus/api/edge.py` and generated
`apps/web/src/lib/api/wire.gen.ts` now require wire `15`.

release api/web together. rebuild and pair any native client that sends the
wire revision with the same contract; old-revision clients receive the existing
`426 E_WIRE_MISMATCH` response. no compatibility reader or schema migration.

resolved when deployment uses matching wire `15` clients/api, old clients are
refused, and subscription/import/unsubscribe/cleanup header and menu actions pass
real-browser acceptance. deployment remains pending.
