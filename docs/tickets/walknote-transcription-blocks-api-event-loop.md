# walknote transcription blocks the api event loop

status: open · origin: 2026-10-02 cleanup discovery, baseline 56b889bdc6708d2d913982e22e7566a141b024d6 · area: api / walknotes / transcription

`python/nexus/api/routes/walknotes.py:18` declares an async handler, then calls
synchronous `get_deepgram_client().transcribe_raw_audio(...)` at line 36.
`python/nexus/services/podcasts/deepgram_adapter.py:74` delegates to `_listen`,
whose line 93 calls blocking `httpx.post` with the configured transcription
timeout. the provider request therefore runs on the api event loop, delaying
unrelated requests and sse work in that process until it returns.

prerequisite: retain the raw-audio result and error contract; provider credentials
are needed for real concurrency verification. reproduce by submitting a voice
note while requesting health or following an existing sse stream.

fix: dispatch the synchronous transcription call through the existing starlette
threadpool boundary, or provide an async raw-audio operation at the provider
owner. keep the adapter's synchronous worker contract unchanged.

acceptance: during a genuinely delayed provider transcription, unrelated health
requests and sse messages continue promptly; successful transcript and duration,
provider errors, and the 10 mb upload-limit response remain unchanged.
