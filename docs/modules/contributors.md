# contributors

status: behavior and static qualified
origin: 2026-10-02 author retirement; baseline `2b7d7ac899826f0f4b03d271fd606ea28c53d207`

`services/contributors.py` owns search, detail, works and media-author editing.
`contributor_writes.py` owns identity/credit writes; `contributor_credits.py`
owns ordered credit projections. routes parse inputs and envelope those outputs;
visibility stays in the existing predicates. opaque handles grant no access.

author rename is retired: the disabled `Edit name…` item, detail `canRename`,
`RenameContributor` capability and dead request/client/dialog/handoff are gone.
contributor api and bff retain get and reject patch with 405. no authority is added.

surviving reads retain aliases/examples, handle visibility and reserved/invalid
outcomes, credit roles/order/nulls, all three work variants and dates, ordering,
filtering, cursor binding and revisions. author activation and media-author
edit authority/replay/reset are conserved. this cut changes no stored value,
table, migration, ingestion or account/session behavior.

## contracts

the three reads expose their existing owned models through `Data` and generated
wire types. works retains `{data:{items,collectionRevision,nextCursor}}`.
nullable output members are required, including shared `ContributorCreditOut`
fields; input credit `raw_role` stays optional. both direct credit constructors
supply all seven keys, as do the real search rollup and gutenberg sql readers.
the three surviving read response bytes stay identical except detail's removed
`canRename`; snapshots retire the capability separately.

`contributors/api.ts` owns the detail and works projections shared by the api
client and pane seed; the handwritten author json decoders are deleted.
brands, presence, dates, minute ranges and safe revisions keep their semantic
owners. page conversion retains `ApiError(200, "E_INVALID_RESPONSE")` and reuses
cursor/revision factories without an endpoint-dependent generic page abstraction.

`mediaSummaryFromWire` is the single date/duration/modality projection for typed
author and current search reads. existing unknown media/reading-time ingress
parses wire grammar and delegates the same domain conversion. invalid unknown
credit roles now fail the finite vocabulary; invalid typed search minutes now
fail canonical range checks. valid server facts are conserved. the separate
[nonmedia date contract gap](../tickets/author-nonmedia-work-dates-have-no-producer.md)
remains open: current podcast/catalog work dates are always null.

## works view

`GET /contributors/{handle}/works` owns four views; `lib/contributors/workView.ts`
is the strict url codec and `Sort by` inventory.

| query, excluding pagination | order |
| --- | --- |
| no `sort` or `direction` (canonical) | original publication, oldest first |
| `sort=published&direction=desc` | original publication, newest first |
| `sort=title&direction=asc` / `desc` | title a–z / z–a |

redundant `published+asc`, partial pairs, duplicate keys and unknown values
are `E_INVALID_REQUEST`; the pane shows invalid-view reset and never commits
seed rows. the date is media `original_published_date`; podcast and
catalogue-only works are undated. publication orders sort by
`(date_missing asc, date, title, href)`, so undated works stay last in both
directions and partial dates keep their precision; sql applies visibility,
order and keyset pagination to the whole relation. only `AuthorWorks:v3`
cursors decode; older ones are `E_INVALID_CURSOR`.

## qualification

tested source `0e8bcbb8fee1addf302260942986e334ba566d8b`, tree
`0cbaf1e37aaf45cd9c5dbcd9f53a55dfd9561300`, on integration base
`2efd00ae4c830f16ac149931afa4d47dd0957ec0`. source and frozen probe/dump hashes
are recorded in the campaign receipts; author api hash `b7c4459b…`, combined
wire hash `e8a2ab9e…`. later `c8b824b7b` tool-catalog integration retains
the exact 25 affected production-path hashes, including deletions. behavioral
proof remains bound to `0e8bcbb8f`. the pre-430 static gate passed on rebased
source `912b7940c0640914f28622adfadcca16189842c3`, including generated-wire
freshness and migration head 0252.

later chapter-read integration (#430) retains all 25 authored production-path
hashes. a focused public decoder/projector comparison on saved real media-detail
json passed 18/18 at `957228237a521de565462be4f44116b590967693`. no new live
browser proof is claimed. the final static gate passed on
`cf7ac62c79163a2fcd301acfe96e72673967acd2`, including generated-wire freshness
and migration head 0252. later atlas schema integration retains all 24
handwritten production-path hashes and all 23 owned author/media schema blocks;
only the combined generated artifact changes (wire hash `7d69fca9…`). the final
static gate passed on `1cc7eee8351300ab24d6779502e6f17b9e62a64d`, including
generated-wire freshness and migration head 0252. this last receipt edit changes
documentation only.

| owner proof | original baseline | integrated candidate |
| --- | --- | --- |
| api/bff read bytes, access, pages, retirement, schemas | 112/122; ten intended retirement failures | 164/164 |
| browser author/read/library/editor journey | 19/20; obsolete menu present | corrected 19/19 |
| postgres edit authority, replay and denied/no-write paths | 42/42 | 42/42 |
| public semantic owner conversions | 37/37 | 37/37 |
| direct discovery-credit constructors | 2/2 | 2/2 |
| current search wire/projection; browser | added after peer search landed | 20/20; 7/7 |
| post-430 saved media-detail json conversion | prior decoder compared | 18/18 |
| sole static gate `./scripts/test` | passed on baseline `2b7d7ac` | passed on `1cc7eee83` |

original candidate browser probe passed 10/11 and stopped: its global menu
selector clicked a restored library sibling and activated it after peer repair made
restore functional. the settled diagnostic showed requested media active with
its own enabled editor before the correctly scoped click. paired corrected
probes on pre-cut `ad61943b9` and source `b4c7c53d7` passed 19/20 (only obsolete
menu) and 19/19; assertions were unchanged. this was a probe correction.

wire parity compares raw bodies; detail excludes only its removed member.
action-snapshot parity compares surviving ordered structures separately.
a library continuation returned 409 after a reader-state write; its original
body was not captured. a later fresh replay separately returned
`E_COLLECTION_CHANGED`, supporting the revision-guard inference.
fixtures use isolated postgres, real local auth, api, bff and chromium; no
production, paid provider or physical-device qualification is claimed.
temporary probes are removed after review; no maintained suite is added.
