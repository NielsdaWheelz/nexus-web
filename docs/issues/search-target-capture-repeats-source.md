status: open
area: resource target search / captured evidence

`search/pickers.py:_targets` calls `capture_evidence` separately for every
materializable candidate (lines 132–137). `resource_items/evidence.py:_capture`
then calls `source_excerpts` with one request (lines 227–239). several indexed
chunks from the same admitted reading/fragment therefore parse and project the
same source repeatedly within one target-search request. internal grouping in
`source_excerpts` cannot combine those separate calls. this is a confirmed call
path, not an observed endpoint timeout; source-window capacity qualification
so far exercised one actual chunk per large source.

impact: target search can multiply full-source scans and subprocess startup by
the number of otherwise small candidates, despite bounded resulting excerpts.

proposed fix: add request-scoped batch capture at the existing evidence owner.
read current candidate words/locations, batch rich `SourceExcerptRequest`s,
then attach the returned frozen excerpts in input order. preserve each reading
identity and the existing before/after publication fences across the complete
batch. keep the single-target entry as a thin one-item call if still useful;
no cache or session lifecycle is needed.

acceptance: actual target search returns several frozen captures from distinct
indexed chunks in one large admitted fragment, with exact selected words and
current publication fences, using one native-source scan/projection for that
reading/fragment group. verify through canonical lab and normal public APIs.
