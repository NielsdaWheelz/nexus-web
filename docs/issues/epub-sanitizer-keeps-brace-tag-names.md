# the epub policy keeps elements whose tag name holds `}`

status: open (owner judgement: unwrapping them changes new rows)
origin: 2026-10-20 review fix of the reader python ingest re-slice (13a)
area: reader python, html substrate

libxml2 2.14 accepts `}` in a tag name. the epub policy
(`python/nexus/services/sanitize_html.py`, `sanitize_epub_chapter`) names a
tag by `local_name`, which reads `x}a` as `a`, so `<x}a href=…>` and
`<x}img src=…>` survive as elements no allowlist names, with an allowed
href/src and the outbound `rel`/`target`/`referrerpolicy`; `<x}script>`,
`<x}style>` and `<x}template>` are dropped with their content. this is main's
epub rule (`epub_sanitize.py` before the re-slice), kept byte for byte. the web
policy lowercases the whole name, so it unwraps them.

impact: none known. a browser parses `x}a` as an unknown element, so the href
and src are inert, and its text is text in both the reader and canonical text.
the stored html holds an element the allowlist does not name, and an author
must write malformed xhtml to get one.

evidence: `2026-10-20/rpy/harness/offline/probes/review_f1_f5.py` (`tags epub`
on main `157b84471` and the branch); the sanitizer differential's adversarial
inputs 24-26 report the epub policy unchanged.

proposed fix: name epub tags by their whole lowercased name, as the web policy
does (`parse_html_document` is lxml's html parser, which never produces a
`{namespace}` prefix); new rows only.

resolved when the epub policy unwraps such elements, or the owner keeps the
rule and this file goes.
