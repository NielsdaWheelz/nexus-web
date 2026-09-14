# image proxy retains up to 128 mib in the api process

status: open
origin: 2026-09-13; bounded-workspace implementation
area: api image delivery / memory qualification

`python/nexus/services/image_proxy.py:36` configures a process-global cache of
64 images and 128 mib (`_cache = ImageCache()`, line 139). `/media/image` serves
reader/other image requests through it (`api/routes/media_assets.py:24`).
`image_validation.py:26` permits 10 mib encoded images. cache residency alone
can therefore consume 40% of the incident's 320 mib api cgroup; request buffers
add to that. this is a code-established allocation owner, not yet measured proof
that it caused a particular production kill. pillow `verify()` avoids a full
raster decode here; do not attribute a hypothetical 64 mib decode to this path.

prerequisite: inventory remaining proxy consumers and measure their actual
concurrency/residency under the existing capacity controller. new reader
publication preparation must call the shared validation/fetch core in workers,
not the api cache. resolve other consumers with immutable worker-owned images
or an explicitly qualified cache/admission budget; never guess a smaller cache.

acceptance: reader opens perform no image fetch/validation in the api; remaining
proxy requests satisfy measured api cgroup/residency bounds and preserve image
availability, format validation, redirects and ssrf policy.
