# video, episode and podcast search paths lack live proof

status: open · origin: 2026-10-10 search reauthor (cleanup/search-reauthor) · area: search verification

the reauthor fixes two defects on media that are videos or podcast episodes: a
`format:video|episode` filter no longer returns a duplicate `media`-typed row that the
web view model rejects (spec §6 #1), and an attached or inspected episode or video now
reopens as `episode`/`video` and is citable (spec §6 #2, `search/project.py`: the
hydrated row's type wins). podcasts, episodes and videos also rank through the `media`
and `podcast` families. none of this has run live: the search harness cannot create
video or episode media without real YouTube transcripts or feed ingest, and has no
subscribed podcast.

evidence: campaign `search/harness/baseline.txt` (manual-only list); the families' SQL
executed on an empty migrated database only.

fix: add harness fixtures for one video, one podcast with one episode, and a
subscription (product endpoints, or a fake transcript/feed provider), then journeys for
`format:video`, `format:episode`, a chat citing an attached episode, and owned
resolution of a YouTube and a PodcastIndex target in Browse.

acceptance: those journeys pass on a fresh stack.
