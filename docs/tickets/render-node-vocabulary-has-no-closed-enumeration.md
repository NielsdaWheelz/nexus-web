# direct render-node construction has no closed element/attribute vocabulary

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: publication render contract

## what is wrong

`apps/web/src/lib/reader/publicationDom.ts:89` constructs DOM nodes directly from
decoded render nodes, and nothing on either side of the wire enumerates which
elements and attributes may appear. `python/nexus/services/reader_publication_render.py`
has no enumeration to mirror — it projects whatever the sanitized tree contains.
the closed sets live upstream in two different sanitizers that **differ by source
kind**: `python/nexus/services/epub_ingest.py:183-300`
(`_EPUB_ALLOWED_HTML_TAGS`, `_EPUB_ALLOWED_SVG_TAGS`, `_EPUB_GLOBAL_ATTRS`,
`_EPUB_ALLOWED_ATTRS`, `_EPUB_ALLOWED_SVG_ATTRS`) and
`python/nexus/services/sanitize_html.py:30-93` (`ALLOWED_TAGS`, `ALLOWED_ATTRS`).

so the display authority accepts a vocabulary defined only by whichever sanitizer
happened to produce the bytes, and a mount path that no longer makes script
inert has no closed set to fall back on.

## prerequisites

the enumeration must have exactly one owner. a client-side list in
`publicationDom.ts` is explicitly not acceptable — it would be a third copy that
drifts from both sanitizers.

## proposed fix

declare one closed vocabulary in `python/nexus/schemas/reader_publication.py`,
have both sanitizers' outputs validated against it at publication time, and
enforce it in the decoder `decodeReaderRenderNodes`
(`apps/web/src/lib/reader/publicationContract.ts:332,343`) so an unknown element
or attribute is a decode refusal rather than a mounted node.

## acceptance

a publication carrying an element or attribute outside the declared vocabulary is
refused at decode, and both sanitizers' allowed sets are derived from (or checked
against) that single enumeration.
