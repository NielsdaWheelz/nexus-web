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

lexical-field audit: server `search/sources.py:284–306` searches highlight exact
plus captured prefix/suffix, clipped for the selected reading part. local
`node/authored/src/queries.ts` indexes exact alone, and local excerpts also use
exact alone. an owned context-only hit is therefore lost after remote ownership
suppression. the capture already contains these strings; no new source-text
replication is needed for this field coverage. scoped matching must clip context
using the same reading bounds before pagination, rather than let source context
match outside a part. all-scope context matching is repaired and proved below; reading-part context
clipping remains part of the pending shared scope query.

full scope parity does not promise identical PostgreSQL stemming, semantic
candidates, ranking or label-substring behavior. local FTS uses unicode token
prefixes. scope qualification should compare controlled literal matches and
exact eligibility at a common metadata revision, including pending local edits;
it must not silently expand into semantic-search parity.

actual context-only red on `509c47d69`, lab
`20261025-213945-7eaeb90c9f6d`: real canonical reader captures, exact saved-passage
and highlight matches, and same-query positive-control passage plus exclusion of
the original passage all passed. the first prefix-only highlight search showed
only the whole-paragraph control highlight; the original exact-quote highlight
was absent. the shared index now covers captured prefix/exact/suffix fields and
the local excerpt uses the same shared ordered fields as literal captured text.
labels and navigation remain the exact quote, and saved passages remain
exact-only. the canonical static gate passes. run `20261025-220418-077b1b573dad` on
`6f9e41b48` passes the same real offline context searches, literal excerpts, exact
quote labels, exact-only saved passages and absence of duplicate/source rows.
this does not implement the pending scoped-source metadata contract.

bulk scope-input delivery is also unresolved. the current draft places complete
scope facts/text in the initial authored snapshot. the actual 100,000-note bff
stream at `e2f9a0c30` took 223.5 of the existing 280 seconds for 219,541,458 bytes.
rendered epub text supports 64 mib per source; the admitted input universe has no
aggregate text-size bound. bounded records alone therefore cannot guarantee that
one complete snapshot fits the deadline. this is a protocol gap, not evidence
that any particular extra book already failed the budget. building the whole
text publication while holding the authored head also leaves write latency
proportional to bulk source bytes.

before implementing text replication, separate the authored snapshot deadline
from resumable, bounded scope-input hydration under the existing sync/staging
owner. each text page must use the exact authorized reading/publication/slice
contract, recheck current admission, and never publish partial scope facts.
source/part replacement must invalidate or restart affected staging without a
network-held database transaction. keep prior complete scope facts readable
while refreshing, but explicit revocation must withdraw the affected scope;
unknown scopes remain explicitly unavailable. no new source admission or reader
get mutation follows from this delivery change. qualify a supported large source,
multiple-source aggregate, interrupted hydration and publication/revocation races
within unchanged per-response budgets. the source-text product choice remains
pending; no dependent production code is authorized.
