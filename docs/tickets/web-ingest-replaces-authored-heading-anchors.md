status: open
origin: 2026-09-12 reader cutover adversarial review, `329bac8622`
area: web article ingestion

`python/nexus/services/web_article_structure.py:264–275` replaces authored
heading ids unless they already match its generated prefix. it does not rewrite
source `href` or `aria-labelledby` references. an imported `href="#chapter"`
can therefore lose its destination when the heading's `id="chapter"` is replaced.

prerequisite: distinguish new-ingest correction from repair of already stored
source; do not mutate immutable source or canonical identities through navigation.
preserve unique authored heading ids and mint ids only where absent. explicitly
classify duplicate authored targets; repair existing imports from source evidence.

acceptance: a real web-ingest proof retains an authored heading, an internal link,
and its labelled container; each resolves after canonicalization. generated ids
remain deterministic for unanchored headings. existing-source repair preserves
canonical text and accepted locators.
