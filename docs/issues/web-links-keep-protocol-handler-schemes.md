# web articles keep links to protocol handlers

status: open (owner judgement: restricting schemes changes new rows)
origin: 2026-10-20 review of the reader python ingest re-slice (13a)
area: reader python, html substrate

the web policy (`python/nexus/services/sanitize_html.py`, `sanitize_html`, the
`a` arm of its `visit`) removes a link's href only for the javascript, vbscript,
data and file schemes. any other scheme survives with `target="_blank"`:
`mailto:`, `tel:`, and os protocol handlers such as `intent:` (android) and
`ms-msdt:` (windows; cve-2022-30190's vector). this is main's rule, kept byte
for byte by the re-slice. the epub policy keeps only relative and http(s) links.

impact: a stored article can carry a one-click link to a local handler on the
reader's device. browsers usually prompt before launching one, so this is a
missing layer of defence, not a demonstrated exploit.

evidence: `<a href="ms-msdt:/id">`, `<a href="intent://x#Intent;end">` and
`<a href="mailto:a@b">` keep their hrefs on main `157b84471` and on the branch;
the sanitizer differential (`2026-10-20/rpy/harness/offline/diff_sanitize.py`,
adversarial input 29) reports them unchanged.

proposed fix: an allowlist in the web policy (http, https, mailto; tel if
wanted), as the epub policy has; new rows only.

resolved when the web policy names the schemes it keeps, or the owner keeps the
denylist and this file goes.
