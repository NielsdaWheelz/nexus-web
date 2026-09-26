status: open
origin: 2026-09-12 reader cutover adversarial review, `329bac8622`
area: web article ingestion

2026-09-25 article-contents source review, `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`:
the loss starts before heading anchoring. `python/nexus/services/sanitize_html.py:94–109`
removes authored `id`, anchor `name`, and `aria-labelledby` attributes.
its `:117–129` turns `href="#chapter"` into a source-site url with
`target="_blank"`. `web_article_structure.py:119–127` then calls
`add_heading_anchors`; `:267–280` mints replacement heading ids. repairing that
last function alone cannot preserve source references or labelled containers.
the generated contents can still navigate through canonical text offsets; this
is not evidence that article contents are absent.

browser capture additionally strips `aria-labelledby` in
`apps/web/src/extension/content.ts:160–180`. preservation must cover both
capture and backend ingress; changing the backend alone cannot recover an
attribute already discarded by the extension.

prerequisite: distinguish new-ingest correction from repair of already stored
source; do not mutate immutable source or canonical identities through navigation.
preserve unique authored targets and their relationships through the shared
sanitization/structure boundary, with safe rendering and pane-local resolution;
mint ids only where absent. distinguish same-document targets from outbound
links. explicitly classify duplicate authored targets; repair existing imports
from source evidence. account for
[saved-cursor reconciliation](web-publication-invalidates-saved-reader-cursors.md)
before replacing existing fragments.

acceptance: a manual web ingestion retains an authored heading, an internal link,
and its labelled container; each resolves after canonicalization. generated ids
remain deterministic for unanchored headings. existing-source repair preserves
canonical text and accepted locators.
