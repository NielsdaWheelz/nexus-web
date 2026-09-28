status: open
origin: 2026-09-27 source-note integration adversarial review; baseline `dc9838cf6` (pr #393)
area: epub apparatus identity

`html_apparatus.py` indexes both `id` and `name` on one anchor (lines 156–168)
but creates target identities by cited string (lines 357–387). with two
reciprocal references, one to each alias, it emits two footnote targets and two
edges for one physical note. stamping the same element twice leaves only one
target stamp. the two target keys are `epub:0:target:fn` and
`epub:0:target:alias`; four items have only three DOM item-id stamps. reproduce
with:

```python
html = '<p>prose <sup><a id="m1" href="#fn">1</a></sup> more prose <sup><a id="m2" href="#alias">1</a></sup></p><p><a id="alias" name="fn" href="#m1">1</a>. note prose <a href="#m2">return</a></p>'
extract_html_apparatus(html, source_kind='epub:0', document_href='doc.xhtml', source_ref={'format':'xhtml'})
```

prerequisite: define target identity by the unique authored element while
retaining both address aliases. update the extractor and reciprocal index
together; reject cross-element alias collisions.

acceptance: both references point to one target identity and one DOM stamp;
existing item/edge identities with dependents remain unchanged or require an
exact fenced repair. the full restored corpus and focused alias/collision
probes pass.
