# resource graph

status: implemented · updated: 2026-10-10 reauthor (one writer, two read models)
origin: 2026-10-09 cleanup campaign, graph slice; [connections](connections.md) owns
discovery and the Connections surface's product rules.

## the idea

the graph stores one fact per `resource_edges` row and asks three questions of it:
*may this fact exist* (the writer), *what is around this resource* (the connections
read model) and *what does this output cite* (the citation read model). each answer
has two representations only: the row and the generated wire model. there is no
service-side mirror of the wire, no decoration of it on the web, and no second
snapshot shape.

by the writer's shape law a user link is the only `origin = 'user'` fact and is always
neutral (`kind = 'context'`, no ordinal, snapshot or order key) and stored in canonical
order (source uri before target uri, by codepoint). every reader therefore spells "is a
link" as `origin = 'user'`. migration 0268 proved both properties for every stored row
before the readers relied on them.

## owners (`python/nexus/`)

| concept | owner | the one rule it enforces |
|---|---|---|
| ResourceRef | `services/resource_graph/refs.py` | a string that parses is canonical; `require_ref` is the one 400 for request refs |
| Hydration | `resolve.py` | one loader per scheme whose SQL selects only rows the viewer may see; missing, forbidden and unknown hydrate as `(resource unavailable)`; writes use `assert_ref_visible` (404) |
| Edge (fact) | `edges.py` | the shape law per origin (`_ENDPOINTS` + `_validate`), endpoint visibility, bare-pair uniqueness (400); flush-only; the only module that builds rows and, with `cleanup.py`, deletes them |
| Link | `edges.create_link` / `restore_link` (store), `links.py` (commands) | canonical order, unordered-pair reuse (`created=false`), ranks at chats and outline endpoints, `links` version bumps on both ends |
| LinkNote | `edges.detach_link_notes`, `links.put_link_note` | a note attached to both ends of a link; detaching never deletes the note |
| Citation | `citations.py` | dense 1..N per output; `_citation_outs` is the one hydration (visibility, activation, jump, media abstract) |
| Jump | `reader_targets.py` | position lives in the target and is recomputed on read; callers pass only visible targets |
| ChatContext | `context.py` | `context_facts_sql` is the only membership law (search scope shares it); direct only |
| Connection | `connections.py` | `other` is the far end; links are `undirected`; `mutation` names the only removal |
| Death | `cleanup.py` | ordinal edges die with their source, other edges with either end, a dying end takes its link-note motif; view states first; orphan external snapshots after |

`schemas/resource_graph.py` holds the vocabulary (`EdgeKind`, `EdgeOrigin`, the
stored `CitationSnapshot`) and every graph wire model; `schemas/citation.py` holds
`CitationOut` (its target type is every `ResourceScheme`) and `CitationSnapshotOut`.
`api/routes/resource_graph.py` holds the five graph routes and
`DELETE /conversations/{id}/context-refs/{edge_id}`.

web (`apps/web/src/`): `lib/resourceGraph/resourceRef.ts` (grammar, scheme icon and
label), `links.ts` (http client, link-mutation bus, `mutateConnection`),
`citations.ts` (`CitationOut` → `ReaderCitationData`, reader jump dispatch),
`useLinkComposer.ts` (one store for the link session: intent freezing, close keeps a
save running, failure placement, undo), `components/resources/LinkTargetDialog.tsx`
(the picker on the shared `Dialog`, with the targets search inlined).

## contracts

| route | success | errors |
|---|---|---|
| `POST /resource-graph/connections/query` | 200 `ConnectionPageOut`; unknown or private refs → empty | 400 bad ref or cursor, schema |
| `POST /resource-graph/links` | 201 `CreateLinkOut{created, created_source_ref, connection}` | 404 invisible; 422 `E_LINK_SELF`, `E_LINK_CAPABILITY`; 409 `E_LINK_TARGET_STALE`, replay mismatch |
| `DELETE /resource-graph/links/{id}` | 204, also when absent | 403 non-user edge |
| `PUT /resource-graph/links/{id}/note` | 200 `LinkNoteOut` | 404 not a link; 409 `E_NOTE_CONFLICT` |
| `DELETE /resource-graph/links/{id}/note` | 204, replayable | 404; 409 |
| `DELETE /conversations/{cid}/context-refs/{eid}` | 204 | 404 (only bare citation/system facts) |

`ConnectionOut{edge_id, direction, kind, origin, snapshot: CitationSnapshot|null,
source_order_key, ordinal, source, target, other, link_note{note_block_id, preview},
creation, mutation, created_at}`; endpoints are `{ref, label, description, activation,
missing}`. newest first; cursor `"<iso created_at>|<edge id>"`. the three replayed
commands (create link, put and detach link note) run SERIALIZABLE and look their memo
up before anything else, so a replay outlives the link it answered.

## behaviour changes in the 2026-10-10 reauthor

- media endpoints in Connections, Evidence and dossier connection candidates describe
  the media by kind only (no "~N words · M pages"): the read model no longer computes
  document navigation per row. prompts keep the metrics.
- span labels read `{work} - {first line}` when the citation label repeats the work.
- citations of libraries, chats, oracle readings, contributors, podcasts and passage
  anchors hydrate (dossiers no longer fail to read).
- link-note replay after the link is deleted returns the original response.
- a re-pick after a definite failure leaves no stale "Link wasn’t created" notice; an
  unknown outcome still does. opening Link while a save runs says "Another link is
  being saved."
- the picker is the shared `Dialog` (centred, "Close dialog" icon, fixed-height list,
  shared Load more).
- `GET /conversations?has_context_ref=…` answers 400; malformed-fact 400 messages are
  reworded; a duplicate ordinal or order key would be a 500 (no caller can make one).
- connections pages carry no `citation` block, endpoint `scheme`/`id`/`href` or
  `source_ref`/`target_ref`.

## qualification

the slice harness (`nexus-web-campaign-artifacts/2026-10-09/graph/harness`, an
isolated compose + supabase + workers + `next start` stack with sealed fakes) runs the
J1–J11 journeys except four ui checks it cannot stage without new fixture machinery
(`graph/harness-changes.md`, "not added"): the pdf region link (J2), the note citation
pulse (J8), assistant Undo with the full reason list (J4/J5), and the outline updating
without reload (J11; covered at the api). parity journeys run the same probe in an
image of the pre-reauthor tree and in the reauthored api against one database: P1
(resolve, 3 viewers × 19 schemes) and P2 (connections over media, page, note, chat,
library and author refs, both rollups, paged at 7) match except span labels whose
citation label was empty or repeated the work title; P3 checks the single-writer law in
source. the seven schemes the fixtures lack (oracle reading and passage anchor,
artifact and revision, external snapshot, podcast, apparatus item) were compared once
at review on a seeded database at 0268, three viewers plus an unknown id each: no
difference. receipts are in the campaign artifacts (`graph/rewrite-run*.txt`,
`graph/harness-changes.md`).
