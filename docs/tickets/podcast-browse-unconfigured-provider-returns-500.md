# unconfigured podcast browse returns 500

- status: open
- origin: 2026-09-26 source-notes/navigation acceptance
- area: browse provider availability

an authenticated `GET /browse?q=Talk%20Python&kind=Podcast&source=PodcastIndex&limit=5`
on the isolated stack returns `500 E_INTERNAL` when podcast index is not configured.
`python/nexus/services/browse/podcast_index.py:232` raises
`RuntimeError("Podcast Index Browse provider is not configured")`; the browse route
only maps `BrowseProviderFailure`. this blocks ordinary acquisition of a publisher
transcript for the transcript-find acceptance journey.

receipt: `/tmp/nexus-source-notes-b-20260926/generic-prerequisites.json`;
traceback: `/tmp/nexus-reader-source-notes-stack/api-green.log`.

reconfirmed on isolated main `33a1446c` on 2026-10-04: genuine authenticated
`GET /browse?q=history&kind=Podcast&source=PodcastIndex&limit=1` returned
`500 E_INTERNAL` with credentials absent (old browse receipt sha256
`18dd91da61607a61837335abbf378e0c216ba79619b14376346d4462110eaa36`;
adapter sha256 `f5b2fec44f292389f8ecdb3413312e2399c81db403e46e19701d8fc8814e7cb0`).

prerequisite: keep configuration absence distinct from a malformed provider response.
return the existing explicit unavailable-provider result at the provider owner;
configure podcast index separately when actual acquisition is needed.

acceptance: with credentials absent, the public browse endpoint renders its existing
unavailable state without an internal error; with valid credentials, normal episode
acquisition can retrieve a publisher transcript without generated transcription.
