# Public handle key derivation duplicates sealed_handles

status: open · origin: 2026-09-28 resource-sharing reauthoring (size/resource-sharing) · area: resource sharing / sealed handles

`services/public_resource_sharing.py:_tag` derives its per-domain key as
`HMAC-SHA256(root, b"nexus-handle-key\0" + domain + b"\0" + b"1")` over the
base64-decoded `STREAM_TOKEN_SIGNING_KEY`: byte for byte what
`services/sealed_handles.py:_derived_key` computes for entity handles. two
owners of one key schedule can drift.

impact: none today. a change to either copy (root decoding, minimum length,
input layout) silently rotates `nxps1_`/`nxpa1_` handles in open tabs, or the
entity handles.

fix: export one `derived_key(domain, version)` from `sealed_handles.py` and call
it from the public codec. `consumption/handles.py` cannot join: its key input
has no `\0` + version, so merging it would break its handles.

resolved when: one function derives every `nexus-handle-key` domain key, and a
handle minted before the change unseals after it.
