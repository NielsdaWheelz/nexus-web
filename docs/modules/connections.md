# connections and suggestions

connections inspects relationships. link… authors one neutral user connection.
discovery writes machine connections. suggestions ranks items to read or file;
it stores no recommendation and owns no destination membership.

| owner | contract |
| --- | --- |
| `services/resource_graph/{edges,connections,context}.py` | one link writer; fact projection and mutations; shared chat membership |
| `services/resource_items/{capabilities,targets}.py` | symmetric endpoint admission and read-only target search |
| `services/connection_discovery.py` | queue, status, dismissal, retrieval, judgment and fenced publication |
| `services/suggestions.py` | lectern, quick reads and library ranking in one snapshot |
| `services/resource_graph/owners.py` | endpoint-to-work projection used by exclusions and ranking |
| web `lib/resourceGraph/useLinkComposer.ts` | one composer for menus, panes, selections and saved uploads |
| web `components/connections/ConnectionsSurface.tsx` | paginated facts, owner actions and verified creator navigation |
| web `app/(authenticated)/media/[id]/evidence/` | passage-aligned connections, source notes and annotations |
| web `components/collections/SuggestionsSection.tsx` | destination-owned add, stable survivors and bounded refill |

python paths are relative to `python/nexus/`; web paths to `apps/web/src/`.
[the cutover plan](../connections-plan.md) owns admission, writing and migration
details; [the receipt](../connections-verification.md) records observations.

## relationships

user links are canonical unordered pairs: `origin=user`, `kind=context`, no
ordinal, snapshot or source order. the database enforces viewer/pair uniqueness;
the writer owns shape, visibility and atomic materialization. endpoint ordering
is independent. search and pre-submission cancellation write nothing.

connections preserves one row per fact: user, assistant, discovery, citation,
annotation and source-owned attachment. directed facts retain their meaning.
only the owning operation supplies removal. assistant creation and undo come
from durable receipts; legacy bare edges expose neither invented navigation
nor generic delete. removing a link never deletes its resources or note body.

chat membership combines incident user links and outgoing citation/system
context facts. citations and context attachments remain distinct. new turns use
current membership; admitted turns retain frozen scope. a linked chat exposes
completed branches through bounded reads, without traversing its attachments.

## discovery

note/page connections offer find connections. existing highlight creation,
pdf highlight creation, media-unit readiness and note reindexing enqueue scans.
the ui refreshes after settlement and announces success only for outcome `ok`;
an idle queue alone proves no successful generation.

- only discovery writes `origin=discovery`: source is media, page, note or an
  owned highlight; target is media, note or evidence span; snapshot excerpt is
  the stored rationale.
- `ok` replace-sets that source's discovery facts, including an empty set.
  `skipped` and `terminal_failed` leave them unchanged. assistant work survives.
- at most twelve candidates, four links and two links per work. exclude self,
  page-owned notes, existing relations and dismissed work pairs.
- one job key is `connection_discovery_scan:<user>:<ref>`; queueing is flush-only
  inside a savepoint. `CONNECTION_DISCOVERY_ENABLED=false` disables admission.
- generation-journal replay retains frozen `connection_discovery-input.v2` and
  the terminal memo. publication runs under the actual job lease in a fresh
  serializable transaction, rechecking visibility and exclusions.

already-related checks read relations incident to the source itself and project
the far endpoint to its work. a highlight scan therefore does not inherit every
relation of its media. dismissals project both endpoints to works: dismissing
one passage suppresses sibling passages and scans from either work, including
a dismissal committed while generation runs.

| api | result |
| --- | --- |
| `POST /connection-discovery/scans {ref}` | `202 {data:{status,outcome}}` |
| `GET /connection-discovery/scans?ref=` | `{data:{status,outcome}}` |
| `POST /connection-discovery/edges/{id}/dismiss` | `204`; unknown/foreign `404`, wrong origin `409` |

status is `idle | pending | running | failed`; outcome is null or
`ok | skipped | terminal_failed`. a retryable failed job reads pending; dead or
terminal model failure reads failed. both scan routes require a visible source.
the job payload is `{user_id,ref,reason}`, result `{status,error_code,ref}`;
the existing registry owns retries and its renewable 300-second lease.

## suggestions

all reads use one read-only repeatable-read snapshot and one `now()`. ranking
performs no request-time model call, embedding, job or persistence. lectern
suggestions exclude finished media and current members; library suggestions
exclude destination members and require relational evidence; quick reads retain
their separate unfinished-document/time eligibility.

sql assigns continuity, arrival, rediscovery or graph-thread families and order,
with twenty candidates per family. lectern rotates families then backfills;
libraries take strength order. diversity retains the current reason, kind,
anchor and author caps while alternatives exist. continuity/arrival borrow no
relation evidence. semantic neighbors use only the calibrated embedding identity
and threshold before limiting rows. this cutover changes no ranking policy.

`GET /lectern/suggestions` and `GET /libraries/{id}/suggestions` return
`SuggestionsOut`; `GET /lectern/quick-reads` returns `QuickReadsOut`.
add calls the existing destination owner, retains visible survivors and appends
at most one replacement. collection rows show factual item metadata; explanations
of relationships remain in the opened resource's connections.
