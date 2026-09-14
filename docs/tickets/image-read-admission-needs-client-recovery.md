# image admission is not qualified until its allocation is measured

- status: open
- origin: 2026-09-13 bounded-workspace qualification; narrowed 2026-09-14 adversarial review
- area: foreground image memory / capacity qualification

## what is wrong

`AdmittedImageRoute` (`python/nexus/api/read_admission.py:6-7`) is a stricter
sub-budget of the foreground read pool, and its `max_image_concurrency` is a
`<qualified>` placeholder in `deploy/env/env-prod-backend.example:23`. nothing
has measured what one admitted image read actually allocates while JSON reads,
progress writes and readiness are in flight, so the number the slot is supposed
to enforce cannot be chosen. an admission limit whose size is unknown bounds
nothing.

## resolved: the client half

the consumer half of this ticket is closed and must not be re-argued. both named
proxy consumers now acquire through the artwork provider:
`apps/web/src/components/ui/MediaImage.tsx:11,64` uses `useArtworkReader`, and
`apps/web/src/lib/player/mediaSession.ts:189-211` publishes the provider's own
object URL rather than a proxy URL. the provider fetches under `requestWithRetry`
(`apps/web/src/lib/media/artwork.ts:8,258`), which honours `Retry-After`, and
`apps/web/src/lib/media/artwork.browser.test.tsx:51-75` asserts that a `503
E_READ_CAPACITY` carrying `Retry-After` is retried and the artwork eventually
reads `Ready`. a refused image is no longer stranded.

## prerequisites

the capacity scenario must hold concurrent JSON, progress and readiness load
while an image is admitted. do not reinstate the 128 MiB resident byte cache and
do not add an unbounded server queue; preserve SSRF/content validation and
private access.

## proposed fix

measure the remaining per-image allocation under that concurrent load, publish
the number as `max_image_concurrency` in the release-qualified profile with its
receipt id, and have the `api-capacity` receipt assert the recorded number
against the observed value, so a receipt cannot be published for a profile that
was never written down.

## acceptance

excess image demand stays bounded, foreground reads and writes retain headroom,
and every demanded visible or OS artwork either loads or exposes its terminal
failure — with a real concurrency/recovery receipt naming the measured
allocation rather than a placeholder.
