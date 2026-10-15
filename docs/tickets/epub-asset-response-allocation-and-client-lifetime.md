# epub asset response allocation and client lifetime

status: open · origin: 2026-09-15 restoration memory investigation · area: epub assets · oi-125

2026-10-13 release evidence: production `3ea1b8e6e` completed 25 image
requests between 18:48:03 and 18:48:05 utc, then its api was oom-killed at
18:48:07 while returning from the complete montaigne essays to a chat.
the images total only 105693 bytes (largest 40001); body volume alone does
not explain this incident. the same window includes two overlapping full-book
reads and a document map that expands 22407 indexed children in python.
private request timeline: `provider-smoke/results/api-access-oom-window.json`.
restored-copy profiling must distinguish these allocation owners.

## evidence

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026`:
`python/nexus/api/routes/media_assets.py:65-90` serves epub assets outside the
external-image fetch limiter. `epub_assets.py:156` loads the whole media row,
including undeferred `plain_text`, for kind/readiness metadata.
`epub_assets.py` writes the complete object into the response buffer (the
storage client is one process singleton, closed at exit).

persisted object size is checked, but this path has no aggregate response-byte
budget. these allocations are source-proven. no epub asset requests were present
near the observed oi-116 production oom, so this ticket does not attribute that
incident to epub assets.

## next action and acceptance

measure concurrent representative epub assets, including actual object sizes.
narrow the media metadata read and establish bounded response allocation without
weakening size integrity, access checks or svg csp. verify the owning path on the devbox
within the existing api limit; do not infer completion from external-image
proxy measurements.
