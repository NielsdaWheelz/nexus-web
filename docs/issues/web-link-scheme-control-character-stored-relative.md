# a web link whose scheme holds a tab or line break is stored relative

status: open
origin: 2026-10-21 ingest follow-ups review (the sanitizer differential, seed 7)
area: reader python, web sanitizer policy

the web policy reads a link's scheme through python's url parser, which, like a
browser's, removes ascii tab, line feed and carriage return first: `t&#13;el:1` is
`tel:1`, so the link keeps its href and opens in place (mailto and tel get no
`target`). libxml2 then serializes the href with the character percent-encoded,
`t%0Del:1`, which a browser reads as a relative url. the stored link is a relative
link to a missing path on the reader's origin, opening in place; main opened the same
href in a new tab. a script scheme cannot pass this way: `java&#13;script:` is
`javascript:` to the parser and is unwrapped.

impact: a link authored with a control character inside its scheme leaves the reader
for a broken in-app path when clicked. no corpus page has one; the capture pipeline
already percent-encodes such characters before the sanitizer sees them.

evidence: `python/nexus/services/sanitize_html.py` `sanitize_html` (`urljoin`,
`urlparse(...).scheme`, `element.set("href", absolute_url)`); the differential's one
unexplained case, `harness/runs/offline/review-diff-sanitize-tip-seed7.txt`
(campaign 2026-10-21/ingfix), identical on the follow-ups' first tip `548bbf52c`.

proposed fix: store the href with ascii tab and line breaks removed, the url the
parser and the browser both read. new ingests only.

resolved when such a link is stored as the url its scheme was read from.
