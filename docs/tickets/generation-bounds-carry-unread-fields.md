# generation bounds carry unread fields

status: open, source-verified.
origin: 2026-10-09 python dead-code sweep (branch cleanup/python-dead-code, base 407fcc735).
area: generation core / frozen generation spec.

seven `GenerationBounds`/`GenerationStreamBounds` fields are set by policy and
frozen into every `GenerationSpec`, but no backend reads them: `max_frames`,
`max_frame_bytes`, `session_open_timeout_seconds`,
`runtime_close_timeout_seconds`, `transport_margin_seconds`,
`text_flush_interval_ms`, `text_flush_bytes`
(`python/nexus/services/generation_spec.py` `GenerationStreamBounds`/`GenerationBounds`,
`generation_policy.py` `_bounds`/`_CHAT_STREAM`). the only readers of bounds are
`instructions_max_bytes`, `input_max_bytes`, `turn_timeout_seconds`,
`transport_deadline_seconds` and `stream.max_stream_bytes`. the chat policy
claims a 100 ms / 8 KiB text flush while `chat_run_worker.py` hardcodes its
`CHAT_TEXT_FLUSH_*` constants.

why not removed in the sweep: specs are `extra="forbid"` and fingerprinted
(`GenerationSpec._fingerprint_matches`). the fields live in stored
`llm_calls.generation_spec`, `chat_runs.generation_spec` and
`background_jobs.payload.generation_admissions`, and the spec fingerprint is
copied into job payloads, step journals and `llm_calls.generation_fingerprint`.
dropping a field strands every stored spec (metadata operation views decode
completed job payloads strictly).

fix: one migration that strips the fields from every stored spec document and
recomputes each fingerprint plus every stored copy of it, or a deliberate spec
schema version bump with history reads that tolerate the old version. then
delete the fields, and either feed the chat flush cadence from policy or drop
the policy claim.

acceptance: the seven names are gone from python; stored specs decode; an
in-flight background job prepared before the change still completes.
