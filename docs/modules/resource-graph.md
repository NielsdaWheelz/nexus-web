# resource graph output boundary

status: implemented · updated: 2026-10-07 connections cutover
origin: 2026-10-04 output-boundary simplification; prior receipts below are historical.

## behavior

| route | success | output |
|---|---|---|
| `POST /resource-graph/connections/query` | 200 | `Data[ConnectionPageOut]` |
| `POST /resource-graph/links` | 201 | `Data[CreateLinkOut]` |
| `PUT /resource-graph/links/{link_id}/note` | 200 | `Data[LinkNoteOut]` |
| `PUT /highlights/{highlight_id}/note` | 200 | `Data[LinkedNoteBlockRef]` |

success preserves the `{"data": ...}` envelope, snake keys, required nulls, values,
array order and statuses. existing services retain requests, permissions, visibility,
transactions and replay. deletes remain bodyless 204; self links remain 422.
private connection queries may succeed with no items.

connections preserve current labels, activation, missing state, citation projection
and folded ordinary link note. direction, rollup, filters, newest-first ordering and
cursor retain their meaning. neutral links are undirected despite canonical storage
orientation; `other` is the far endpoint. pair rows retain their note preview;
annotation-note connections expose their attachment facts independently. owner
mutation and creator descriptors come from the typed server projection.

link creation atomically materializes selected highlights/passages and creates or
reuses a neutral link. reversed duplicates return `created=false`; exact mutation
replay returns its original result, and changed content under that id conflicts.
user links have no stance. deletion stays idempotent and never deletes either
resource or its ordinary annotation note.

first-note save freezes request bytes and replay identity, respects expected absence,
and persists the ordinary note plus attachments together. later saves use the
canonical note body writer with its acknowledged version. acknowledgement preserves
note identity, prosemirror/text agreement, body >= 1 and links >= 0. detachment
preserves the ordinary note. uncertain replies retain the frozen journal entry.

## owners and architecture

`connections.py` owns hydrated reads; `user_relations.py` owns writes/replay;
`schemas/resource_graph.py` owns publication. fresh endpoint identity derives from
one `ResourceRef`; hydration copies href from activation and selects endpoints from
one keyed map. native endpoint/connection validators enforce identity/href coherence
when durable replay json reenters those models. existing activation and folded-note
validators stay. shared `NoteBodyVersionsOut` owns exact lanes and bounds, preserving
existing integer normalization. required nullable output fields have no defaults.
these shared models also publish reader connections and linked notes in highlight
reads; current note writers initialize both lanes, with no backfill or fallback.

routes return native `Data`; generated `ApiJson`/`Schema` replace parallel graph
codecs and vocabularies. browser conversion adds branded action identities.
`LinkNoteOut` extends existing `LinkedNoteBlockRef`, so both first-create routes
publish one saved-note contract. the journal writer owns delivery, note correlation,
body normalization and acknowledgement without a mounted annotation. its existing
observers receive semantic body plus optional creation versions; annotations use
the links version without another read. adapters prepare requests and observe
success. canonical later-save and persisted journal decoders keep their owners.

trade: malformed stored replay now fails as a server defect before publication
instead of a browser type error. the writer can complete a restored frozen first-create
without an annotation adapter; recovery admission stays with its existing owner.
structure and numeric representation stay. the later neutral-link cutover,
admission and stopped-writer migration belong to
[connections](connections.md).

## historical qualification

these receipts describe the output-boundary change before the connections
cutover. stance routes and hidden annotation facts below are retired.
[connections](connections.md) owns the new behavior.

pre-integration qualification used temporary isolated postgres/api/browser probes.

api probes freeze nine responses across all five routes.
all nine captured responses preserve every byte, status and captured headers. cases cover paging,
folded note, duplicate/reversed link, exact replay/mismatch, stance and both first
saves; auth, input and private empty-query checks preserve failures. 23 fresh api
requests, adjacent read projections and native replay identity/version fault and
integer-normalization checks pass separately.

pre-integration real auth/bff/api/database browser checks pass 10/10: connection actions,
stance replacement, both first saves without added reads, canonical edit/reload,
committed reply loss, retained journal, note-id fault rejection and exact frozen
retry after reload. observed recovery reopens the annotation with its remote note
present. adapter-independent acknowledgement is source-qualified; generic-route
recovery admission is not live-qualified.

integrated base: `ef3f1d7fef5e20b5508680b82c5374371a54f7d3`.
qualified non-docs source digest: `7b4e207e690c6cb487f345f9bdb85631d27f411617d799017b8805d5829dce4d`.
all nine original response body hashes and statuses match on the restarted api;
three stored request hashes identify the frozen intents. `./scripts/test` passes
(static only). integrated real-stack browser checks pass 9/9: current reader
activation; both fresh annotation puts without added block reads; canonical
`PATCH /resource-items/{note_ref}/body` and hard reload; committed reply loss retaining
the frozen journal; authoritative annotation reload, recover/retry 200 with exact
original request bytes, note identity and mutation id; final persistence after
hard navigation. `GET /fragments/{id}/highlights` and `/media/{id}/document-map` return
200. generic-route admission remains unqualified. delete temporary probes after green.
no pdf float locator, citation/missing-endpoint
variant, production, provider or physical-device acceptance is claimed.

final delivery base is `2e7668a101b4f5808ec46bfc516b9ab156e2263f`; the unrelated
generation catalog/service and three library-governance files differ outside docs
from the live-qualified tree. affected resource-graph and note owners, reader hosts
and generated wire are byte-identical. the static gate passes on final source
`efc416f99c2521920dcfb468b984638171d70269cb2ead25708dd129d88111e1`.
