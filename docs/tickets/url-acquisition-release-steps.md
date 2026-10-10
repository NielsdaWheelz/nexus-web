# url acquisition reauthor: release steps

status: open until the release that carries the url acquisition reauthor.
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: release / ingest.

1. before deploy, the owner confirms the production server env does not set
   `OUTBOUND_HTTP_PROXY_URL` (`deploy/env/*` does not; the server's own env must
   be read). the setting is deleted and unknown env is ignored, so a leftover
   value is inert; but if production relied on it for egress, stop: feeds would
   now dial directly, and pinning cannot hold through httpcore's CONNECT tunnel.
2. api, background worker and web deploy together (`deploy/hetzner/deploy.sh <sha>`):
   the web's failure copy is exhaustive over the generated `SafeFailureCode`,
   so an old web cannot render the new `E_SOURCE_GONE` (`mediaErrorMessage.ts`
   throws on an unknown code). node protocol 2 ships in the same worker image as
   its python caller; queued jobs carry only `requested_url` and run on new code.
3. the extension is unchanged (`article_extraction.mjs` is frozen): no rebuild
   or signing.
4. no migration. historical rows keep `E_SOURCE_FETCH_FAILED` + "HTTP error:
   404" and stay retryable from imports.

acceptance: the release record names the env check result and the single sha
deployed for api, worker and web.
