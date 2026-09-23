# capture buffers source bodies before enforcing limits

status: open · origin: 2026-09-23 firefox v1 review · area: capture transport

file capture reads a complete arraybuffer in `apps/extension/popup.js:232`,
the web proxy reads another complete body in
`apps/web/src/lib/api/proxy.ts:322-324`, and the api reads the whole request in
`python/nexus/api/routes/media_ingest.py:112` before service size validation.
article capture serializes the complete dom before its 2 mib per-html service
limit (`media_source_ingest.py:1000-1005`). large sources can consume substantial
memory before rejection. no live exhaustion was induced.

fix: perform a bounded get at acquisition and enforce matching byte bounds while
reading each request boundary.
reuse the existing upload path if real supported file sizes exceed the bounded
capture transport; do not add a second generalized upload system.

acceptance: missing or dishonest content-length cannot bypass limits;
oversized input stops while reading rather than after full allocation.
