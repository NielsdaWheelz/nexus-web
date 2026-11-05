# source fetch retry-after

required background source requests retain typed temporary failure codes but discard
the upstream retry-after header before queue settlement. a 429/503 requesting a
longer delay can therefore retry at the queue's ordinary 48–72 second cooldown.

evidence: `services/net/safe_fetch.py` constructs `SafeFetchFailed` from the
upstream status without its headers; `source_fetch_error` returns an ordinary
`ApiError`. feed and image adapters likewise retain no retry instant. model
generation and deepgram already pass a typed absolute retry instant.

resolution: retain the declared header at the transport boundary, parse it with
`services/net/http_retry.retry_at`, and carry its absolute instant to the existing
`JobFailure.retry_at` without inspecting exception prose. prove a later delta and
http date delay win over the queue cooldown through real disposable http/queue
boundaries; retain expected source refusals and missing-header behavior.
