# svg figures lose package-relative image dependencies at ingestion

`python/nexus/services/epub_ingest.py:_write_sanitized_svg_asset` sanitizes svg bytes
without first resolving package-relative image dependencies. the shared
`sanitize_html._safe_svg_href` admits only an existing media-asset path for an
`image` href, and only fragment references for `use`. a normal authored
`<image href="photo.png">` therefore loses its href before the svg is stored,
even when the png is present in the epub manifest. the retained whole-book
figure is already incomplete; bounded views preserve that retained content.

reproduce with a displayed svg containing that image reference and a valid
manifest/archive entry for the png. resolve/rewrite admitted dependencies at the
epub asset owner before sanitization, or explicitly refuse the unsupported
figure. resolved when the genuine fixture preserves its image through ingestion
and renders equally in whole-book, piece and public readers without admitting
unrelated assets.
