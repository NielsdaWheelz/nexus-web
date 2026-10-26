# scoped search hides local authored rows

lab32 retained search (`72b0`, media scope) returns an owned unavailable highlight in server search, but the ui drops every authored server row and enables local search only for `scope=all`. the owned quote therefore disappears under media scope online and offline. the canonical local query must apply source membership before its limit/cursor and supply these rows; server authored projections must remain excluded. the existing retained media-scope case is the regression proof. source-backed reading parts need the same explicit membership contract rather than inferred ids or a server fallback.

server scope is broader than source equality: `services/search/scope.py` expands roots through primary thread posts and one contextual level, then `media_text_scope` proves part-local interval containment. the local authored schema has no such current reading-membership facts. part-created text captures do retain their reading identity through `highlight.selection.passage_ref -> passages.source_ref`; highlights created on the source do not carry every possible containing part. an exact-source fix cannot honestly claim parity for those scopes. keep the scoped regression; define the responsible source-metadata contract before expanding admission.

scope audit also found library/conversation variants of the same suppression.
server note scopes follow live direct media/highlight links; conversation scopes
also admit automatic citation/system facts. root media scope includes its proved
composition; a source-backed part needs current complete-anchor containment,
not mere source equality or a captured origin. that metadata is absent from the
current personal format. format/author/role filters already exclude authored
families on the server, so they are not another scope hole.

ownership audit: readable peer highlights are server search facts but are absent
from the viewer's own authored corpus. scheme-only suppression also drops them
in all-scope search. classify ownership explicitly; keep local own writing sole
canonical authority, while authorized peer results retain their remote owner.
do not treat absent/unloaded local state as proof of peer ownership.

ownership repair: every ResourceItemOut now requires
`authored_by_viewer`, derived in one indexed server account/identity batch over
only requested authored refs. canonical hidden identities and newly committed
server writes are included; passage anchors use their own account table.
readable peer highlights and non-authored resources are false. this is personal
writing ownership, not a visibility or authorization grant. clients must suppress
only explicitly viewer-owned remote copies, including matching passages; they
must not infer ownership from a scheme or a missing local row. that client
cutover is implemented; lab35 (`20261025-170315-6cc86ca6581e`, source `597`)
passes the real own-before-feed, readable-peer and hidden-owned identity checks.
scoped local retrieval remains unresolved.

owner selected full offline parity with replicated scope metadata. one material
boundary remains open: metadata alone cannot locate a new offline capture from
an older saved publication inside the current publication's parts. the pending
choice is replicating current searchable text for referenced sources, or using
publication-specific results until reconnect. no image/pdf download expansion
or source-byte permission is implied.

the proposed refresh reuses foreground pull/provision and the existing 30-second
sync cadence, with a coherent source snapshot and durable input revision. broad
invalidation trades extra recomputation for avoiding account fanout and another
job system. large publications still require bounded staged records and an
atomic completion marker; queries keep the previous complete revision until then.
