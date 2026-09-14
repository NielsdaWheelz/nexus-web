# public epub projection reads the retained corpus

- status: open
- origin: 2026-09-14 public asset streaming source review
- area: anonymous sharing / read working set

`python/nexus/services/public_resource_sharing.py:737` validates public epub
shape by loading every section with `limit=2**31-1`; `:1142` repeats the source
load to derive the handle revision. `epub_read.py:66-110` returns complete html
and canonical strings for each navigation row, including repeated fragment
bodies when multiple rows address the same fragment. every public bootstrap,
asset and section request enters this projection. bootstrap is not admitted.
this is a source retention finding, not a measured peak or crash attribution.

prerequisite: preserve source-revision handle binding, shape/type/size vetoes,
whole published-source authority and masked privacy failures. identify an
existing publication-time projection or bounded immutable validation traversal;
do not replace source authority with an unqualified readiness flag.

acceptance: real maximum accepted source with dense navigation preserves all
public bytes, handles and privacy while database/application working sets and
live foreground overlap are measured. asset-body streaming alone does not
close this gate.
