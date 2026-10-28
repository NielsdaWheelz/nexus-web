# highlight reads replace captured context with current source text

problem: a server highlight read combines a saved quotation with surroundings
rebuilt from the current fragment, or clears the surroundings when unavailable.

evidence: source audit at `58e135bf2958bab8ca12971cb3984f77c01c2e66`,
2026-10-28; no browser reproduction.
`python/nexus/services/authored/projections.py:339-365` preserves captured
exact/prefix/suffix, but `python/nexus/services/highlights.py:298-350` queries
current `fragments.canonical_text` and overwrites the output prefix/suffix.

impact: the quotation and its context can refer to different publications;
retained formatting would also be replaced by canonical text. scoped access is
necessary, but must restrict a proved captured excerpt rather than invent new
historical context. this is distinct from historical resource dispatch tracked
in `historical-quotes-use-live-authored-resources.md`.

resolved when refreshing or removing source bytes preserves the saved quotation
and authorized captured context; source-backed pieces reveal no context outside
their admitted bounds; relocation changes only current location, never capture.
