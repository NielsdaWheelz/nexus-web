# the EPUB SVG asset sanitizer screens by value, not by an allowlist

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: epub ingest / sanitizer

## what is wrong

`python/nexus/services/epub_ingest.py:2012` (`_sanitize_svg_asset_element`) now
deletes an attribute when it is one of eleven presentation names **or** its value
contains a `url(` token that fails `project_svg_paint`. that restored the
value-shaped floor the cutover had narrowed away, and a kernel proof covers it
(`python/tests/kernel/test_epub_svg_asset_sanitizer.py`, verified red by removing
the `or "url(" in value.lower()` disjunct).

the stronger form is still missing: the **inline** path has an explicit
per-element attribute allowlist (`_EPUB_ALLOWED_SVG_ATTRS`), while the asset path
still admits any attribute whose name is not on the eleven-name list and whose
value carries no `url(`. an external-resource vector that reaches the network
some other way is not screened.

## prerequisites

the asset path's supported attribute set must be enumerated from the accepted
corpus first; narrowing it blind would reject sources the product accepts today.

## proposed fix

give the asset sanitizer the same per-element allowlist shape as the inline path,
derived from one enumeration shared by both.

## acceptance

an attribute outside the allowlist is removed from an asset SVG regardless of its
value, and every SVG in the accepted corpus survives unchanged.
