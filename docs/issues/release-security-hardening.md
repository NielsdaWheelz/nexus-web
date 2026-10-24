# nexus asset and long-stream edge qualification

problem: live qualification through the api's cloudflare tunnel remains
NOT_RUN for disposable file upload, pdf/offline reading copies, anonymous share
assets and byte ranges, and long stream reconnects. ordinary client success
does not establish these paths.

remaining checks:

- upload a disposable pdf/epub through the normal client, confirm publication,
  render it, and build/download its offline reading copy.
- create a share only for that fixture; anonymously read its summary, document
  and assets. a pdf `Range: bytes=0-15` must return `206`, the correct
  `Content-Range` and 16 bytes. revoke it and prove the masked `404`.
- read a private fixture's signed r2 download with the same range. keep every
  signed url and share capability private; delete only the owned fixture/files.
- keep an event stream alive through the bff's planned 280-second end, prove
  cursor reconnect/resume and cancellation, and check connector memory against
  its 128-mib cap (`apps/web/src/lib/api/proxy.ts:30`).

timeout concern: cloudflare's current default
[proxy read timeout is 125 seconds](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).
`python/nexus/api/routes/reader.py:200` builds the reading-copy zip and uploads
it before returning the signed url. its synchronous response can therefore hit
that limit even though the bff permits 280 seconds. measure a representative
large copy; this is an unqualified risk, not an observed timeout.

upload boundary: `apps/web/src/lib/imports/ingest.ts:197` puts bytes directly to
the presigned r2 url created by `media_upload_sessions.create_session`; only
creation and confirmation use the api tunnel. the api's waf/body limit does
not inspect or bound those direct storage bytes. existing storage admission
and server confirmation remain responsible.

blocker: the android attempt stopped before file selection when phone chrome
became foreground instead of an available picker. no resource was uploaded;
the owned local/phone fixture was removed. repeat with an available client ui.

resolved when these live paths pass with the existing authentication and cache
contracts, or a concrete failure is repaired and verified. retain no fixture,
public grant or executable scenario afterward.
