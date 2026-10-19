# wikimedia article images fail through the image proxy

the hosted copy of “the book of the new sun” contains real wikimedia images,
but an authenticated `/media/image` request for its cover returns 502
`E_IMAGE_FETCH_FAILED`: “upstream denied access (403).” the original public
image returns 200 `image/jpeg` on a direct host request (22,031 bytes).

evidence: native reader qualification, 2026-10-19; request
`31cc3c12-2970-41f8-b4d0-9192f432064b`. image fetch is owned by
`python/nexus/api/routes/media_assets.py` and
`python/nexus/services/net/safe_fetch.py`. this also blocks
using that cover for a genuine late-image reflow check; an error response is
not image evidence.

resolved when: the actual authenticated image route returns a decodable image
for the recorded wikimedia source, with the upstream cause corrected.
