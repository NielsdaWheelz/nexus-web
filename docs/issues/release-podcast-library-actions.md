# release podcast library actions

resource actions replace `AddPodcast`/`StopPodcast` with distinct
`SubscribePodcast`, `ImportPodcastEpisodes`, `UnsubscribePodcast` and
`RemovePodcastEpisodes` kinds. mixed api/web contracts are incompatible;
write endpoints and database schemas do not change.

the action-parity cutover adds `PodcastLibraries` to that closed union and
`POST /podcasts/action-facts/resolve` for local subscription resolution. it shares
the pending wire 15 revision. deploy matching api/web/native clients together;
there is no old action slot, add-only manager or compatibility dispatch.

production source `400e7039e` shipped wire `14`, as recorded by the release
records on main `aa3dfc086`. these actions share the pending wire `15` bump with
the [installed workspace cutover](release-offline-startup.md). do not bump again
before that release. `python/nexus/api/edge.py` and generated
`apps/web/src/lib/api/wire.gen.ts` require the same revision.

release api/web together. rebuild and pair any native client that sends the
wire revision with the same contract; old-revision clients receive the existing
`426 E_WIRE_MISMATCH` response. no compatibility reader or schema migration.

resolved when deployment uses matching wire `15` clients/api, old clients are
refused, and subscription/import/unsubscribe/cleanup header and menu actions pass
real-browser acceptance. deployment remains pending.
