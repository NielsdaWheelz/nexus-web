# native preview artwork lacks its owned origin

- status: open
- origin: 2026-09-13 bounded-workspace image caller survey
- area: native playback preview / artwork delivery

`python/nexus/services/browse/podcast_index.py:411` emits a relative
`/api/media/image?url=...` URL. the web browse contract preserves this as
`MediaImageProxySrc`; native `PlayerProtocol.kt:975` decodes preview `imageUrl`
as a plain string. `NexusPlaybackService.kt:1504` gives that relative URI to
media3 `setArtworkUri` without an owned origin. default media3 datasource URI
handling cannot interpret that path as the authenticated hosted API origin.
canonical playback artwork is different: `consumption/_projection.py:262`
passes the remote podcast image URL directly.

the reviewed current direction sends all mutable playback artwork through the
existing validated image proxy. ordinary source URLs and relative preview
URLs converge on the same authenticated native origin client, exact display
attestation, bounded derivative and current-track lifetime. this adds an API
hop and its auth/availability dependency to ordinary artwork. the earlier
recommendation to leave ordinary artwork direct is superseded by this cutover.

isolated candidate `2b58be55b5` includes reviewed artwork source `332a3470...`,
playback call sites `b46457b7...` and the actual ordinary source HTTP owner
`81bbb4c7...`. strict non-null display dimensions remove the dead unverified
fallback. the existing preview/reconnect/account outcomes remain. canonical
and direct-source fault replays are pending; these source reviews are not
execution evidence. no whole-file overwrite of concurrent main review edits
is authorized by the isolated snapshot.

acceptance: a native preview's relative proxy artwork reaches the configured
owned origin with the required auth, external/ambiguous paths are rejected,
and an admission response has a real delivery/recovery owner. ordinary playback
must also use that origin, preserve its playing identity, and publish the
independently expected decoded derivative. observe direct-source fault
sensitivity and merge the reviewed final delta into the workspace branch.
