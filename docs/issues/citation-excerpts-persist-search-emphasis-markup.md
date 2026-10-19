# citation excerpts persist search emphasis markup

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation architecture audit
area: search / chat retrieval / citations

problem: search-only `<b>` emphasis becomes stored citation evidence and is
shown literally in citation previews and connections. the field named
`exact_snippet` is a truncated, query-decorated display snippet, not exact
source text.

evidence: `python/nexus/services/search/project.py:72-86,203-206` creates a
bounded snippet containing `<b>` markers. `services/chat/retrievals.py:182,255`
copies it unchanged into `message_retrievals.exact_snippet`.
`services/chat/citations.py:180-186` persists that value as the citation
snapshot excerpt. the web renders it as text in
`apps/web/src/components/ui/ReaderCitation.tsx:65-66` and
`apps/web/src/components/connections/ConnectionsSurface.tsx:174-181`.
the audit's read-only firefox inspection also found literal
`<b>spaceship</b>` and `<b>tower</b>` in the current connections tree.

prerequisites: retain the distinction between a search match excerpt, exact
source text, a frozen citation excerpt, and a machine connection rationale.
carry plain excerpt text separately from query emphasis; persist plain
citation evidence at the retrieval boundary. handle existing decorated
snapshots explicitly without treating arbitrary source angle brackets as
markup or silently changing historical quote content.

acceptance: searching, citing and reopening a matching passage preserves its
plain text with no literal search tags in connections, message details or
previews; search alone displays its query emphasis. stored source text and
navigation selectors remain unchanged.
