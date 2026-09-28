status: open
origin: 2026-09-26, epub fragment-only nav fix review
area: epub ingest / source issues

an authored nav href that escapes the package (`../../../escape.xhtml#x`) or
uses an authority (`//example.invalid/#x`) has no safe local target.
`python/nexus/services/epub_ingest.py:_resolve_nav_target` leaves its node
href-less; the source-issue collector at line 507 skips href-less nodes.
the temporary full extraction-plan probe confirmed both entries remain
href-less and produce no `UnresolvedNavigationTarget`. the publisher's broken
link is therefore invisible in recorded source issues.

prerequisite: define an issue representation for authored targets without a
resolved local href; the current `UnresolvedNavigationTarget.href` validator
requires one (`python/nexus/schemas/source_issues.py:40`). record these cases
without making unsafe targets navigable.

acceptance: an epub with escaping or authority-form nav hrefs publishes bounded
source issues identifying both entries, while neither becomes a reader target.
