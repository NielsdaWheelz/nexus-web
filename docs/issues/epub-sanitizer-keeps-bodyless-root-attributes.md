# the epub policy keeps a body-less chapter's root attributes

status: open (low: inert in today's readers)
origin: 2026-10-21 ingest follow-ups (item 5 probe)
area: reader python, html substrate (epub policy)

a chapter the html parser reads without a body (a frameset document) is walked
from its root (`sanitize_epub_chapter`, `python/nexus/services/sanitize_html.py`).
the root `html` is no allowed tag and has no parent, so `_visit_epub` returns
before it touches the attributes: `<html onload="x()" hidden><frameset>…` is
stored as `<html onload="x()" hidden></html>` on main `631dba5dc` and on the
branch (the follow-ups' `hidden` rule leaves a parentless root in place too).

impact: none observed. the reader injects stored html as a fragment, which drops
an `html` start tag's attributes, and the canonicalizer counts nothing in it. but
it is the one path where a handler attribute survives the sanitizer.

evidence: probe `2026-10-21/ingfix/harness/offline/diff_sanitize_ingfix.py`
adversarial inputs (the frameset case) and a direct call on both trees.

proposed fix: strip a body-less root to no attributes (or store nothing for a
chapter without a body).

resolved when that input stores no attribute on any element outside the epub
allowlist.
