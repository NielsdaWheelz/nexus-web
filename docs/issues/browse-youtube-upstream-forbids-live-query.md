# youtube key rejects the local caller ip

status: open
origin: 2026-10-13 pane-controls live qualification
area: browse / provider configuration

the owner explicitly waived successful upstream youtube qualification for the
pane-controls cutover on 2026-10-13. this configuration defect remains open;
waiver is not successful provider proof.

ordinary authenticated `GET /api/browse` for youtube returns `500 E_INTERNAL`;
the provider returned `403 forbidden` with the existing production credential
copied to the isolated runtime. video discovery and its provider-specific newest
order therefore lack successful live proof.

the 2026-10-13 direct diagnostic of the real provider exception returns
`403 PERMISSION_DENIED`, with detailed reason `API_KEY_IP_ADDRESS_BLOCKED`:
the configured key's ip restriction rejects the current caller, `173.46.67.82`.
the outer reason is `forbidden`; this is a configuration defect, not quota
exhaustion or provider unavailability. the isolated, main local, production
and dev-server credentials are identical; no distinct saved candidate remains.

`python/nexus/services/browse/youtube.py:73` sends the standard
`https://www.googleapis.com/youtube/v3/search` request with `part=snippet`,
`type=video`, `q`, `maxResults`, `safeSearch=moderate` and `order=relevance/date`.
no oauth-only ownership parameter is present. these match the
[provider contract](https://developers.google.com/youtube/v3/docs/search/list).
the disposable `youtube-upstream-diagnosis.json` and
`youtube-key-equivalence.json` receipts were removed after qualification.
durable record: #578; exact cause and caller are
retained above.

prerequisite: the key owner adds the current local egress ip to the existing
allowed server ips, preserving other entries, or supplies an appropriately
restricted local key as `YOUTUBE_DATA_API_KEY` in the main checkout's `.env`.
an allowlist repair needs no credential replacement. a replacement key must
also reach the isolated runtime before retrying. preserve strict configuration
defect handling and real provider outcomes.

acceptance: real video discovery and newest sorting pass through browser →
bff → api → youtube, including clear retaining supported facets/order.
