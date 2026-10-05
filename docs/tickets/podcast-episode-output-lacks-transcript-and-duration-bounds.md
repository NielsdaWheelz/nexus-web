# podcast episode output lacks transcript and duration bounds

status: deferred. origin: 2026-10-04 independent source review. area: podcast / success contract.

at `c13ddb87c9b03b1904dcd047c79617a240544829`, `python/nexus/schemas/podcast.py:240–274` exposes unrestricted `transcript_state`/`transcript_coverage` strings and `Presence[int]` duration. `apps/web/src/app/(authenticated)/podcasts/[podcastId]/episodeTranscript.ts:126–175` requires known enums and nonnegative duration.

impact: native typing alone cannot replace these current browser guarantees. no malformed episode response was observed.

prerequisite and fix: census current episode producers, reuse the existing transcript enum owners and preserve the present-duration numeric bound before deleting the decoder.

acceptance: native output owns the same accepted enum/range contract and preserves all serialized presence/null variants and mounted episode controls.
