# source request replay is reported as a content duplicate

status: open, source-qualified; runtime not reproduced here.
origin: 2026-10-04 add-content adversarial review at `f2167baf3`.
area: source admission / upload publication outcomes.

url replay returns `idempotency_outcome="reused"` from
`python/nexus/services/media_source_ingest.py:486-511`, regardless of whether
that intent originally created the media. published upload create/confirm
replay returns `"Reused"` at `media_upload_sessions.py:311-312,555-556`, while
first publication returns `"Created"` at `724-729`. request replay and content
deduplication therefore share one outcome. the browser derives `duplicate`
directly from it (`apps/web/src/lib/media/ingestionClient.ts:332-340,646-671`),
so lost-ack recovery can say `Already in Nexus` for content this request created
(`components/nexus/AddPanel.tsx:143`; capture feedback uses the same fact).

reproduction: accept a fresh url or publish a local file; lose its response;
replay the exact original intent/key. identity is conserved, but the result
changes from created to reused and the browser calls it a duplicate.

prerequisite: admit the native source/upload outcome owner and its consumers
together; the current add rewrite preserves their exported contracts.
distinguish intent replay from content reuse at the server owner and retain the
original content outcome on replay. do not guess it from browser-local history.

acceptance: fresh acceptance followed by exact replay retains its honest
content-created result; a distinct intent that reuses existing content still
reports a content duplicate. retries preserve media/attempt/job identity and
admission fences. qualify native and user-visible outcomes independently.
