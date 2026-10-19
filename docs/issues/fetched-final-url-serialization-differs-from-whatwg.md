# fetched final url serialization differs from the old whatwg form

status: open, design risk 6; no runtime probe.
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: ingest / web articles / dedupe.

the final url of a fetched article is now httpx's serialization of the last hop
(`safe_fetch.safe_stream` → `SafeStreamHeaders.final_url`), handed to jsdom
(`document.URL`) and normalized into `media.canonical_url`. before the rewrite
node's whatwg `URL` serialized it. for characters httpx percent-encodes and
whatwg leaves (e.g. `|`, `^` in paths), a re-add of a pre-cutover article can
miss `uix_media_canonical_url` and publish a second media instead of
superseding.

fix, if duplicates appear: canonicalize the final url with one explicit
serializer before `normalize_url_for_display` (or compare on a decoded form).

acceptance: re-adding a pre-cutover article whose url holds `|` supersedes onto
the original media.
