# passage evidence clamps to one line before the matched words

status: open · origin: 2026-11-02 palette s1 · area: web / nexus rows (s3)

the server's lexical passage window does contain the query: `_literal_match`
(`python/nexus/services/search/indexed.py:382-404`) opens the window 160
characters before the first matched span, aligned to a space, and runs 600
characters. the survey's `flywheel of society` row carried the window `…it
looks like discipline; far, it looks like love. … the enormous flywheel of
society, and how small…` with the match about 150 characters in (the row's
accessible name in `palette-lab/red.log`, criterion 5, word `flywheel`). the
one-line evidence cell (`white-space: nowrap; text-overflow: ellipsis`) shows
only the first ~60 characters, so the matched words are off the end. no server
repair applies; the contract's "s1 repairs the windowing" premise was the
visual clamp, not an omitted term.

impact: a passage row does not show why it matched (goal: "passage evidence
shows the matched words").

fix: in the evidence renderer (`ResourceMatchEvidence` / the palette's
evidence line), window the painted excerpt around the first range: start a few
words before `ranges[0].start`, leading `…`, keep the ranges' offsets shifted.
owner: s3 (`NexusRow.tsx`, `ResourceBody.tsx`).

resolved when a passage row for `flywheel of society` paints `flywheel of
society` underlined in its one evidence line.
