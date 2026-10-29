# optional reuse of resolved passage facts

status: open; duplicate-read optimization, not a release gate.

at source `7173b6a91`, `python/nexus/services/search/project.py:project` resolves
placed passages through `scoped_media_passages`, then calls
`resource_activations_for_refs`. that routing owner calls `media_passages` again,
repeating current-source, authority and quote/dependency placement. the existing
batch and occurrence-aware hydration already preserve the required contracts;
this remaining duplicate is an optional improvement, with unqualified savings.

if worthwhile, reuse authorized resolved facts through the existing activation
owner for the same viewer, reading and snapshot. preserve the last placed per-ref
reading context, authoritative absence, non-passage routing and complete wire
models/activation targets. verify repeated whole/piece refs, bounds, quotes,
allowed dependencies and missing locations. no isolated projection stopwatch or
retired full-read timing gate establishes that proof.

the earlier batch comparison and duplicate-read plan evidence are preserved in
`.nexus-local/search-takeover-20261028.private/docs-before-final/search-passage-projection-reads.md`.
