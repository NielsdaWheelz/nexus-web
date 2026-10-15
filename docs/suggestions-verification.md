# suggestions publication verification

status: implemented and qualified, 2026-10-15; final branch composition is handed
to the release coordinator for its merge window and canonical replay. this merge handoff
does not change main protection or perform runtime/deployment operations.

## artifact and migration

branch: `codex/suggestions-publication`; original baseline: `367da80e0c1b`.
live-qualified application: `01297cb151db0e6fe05688f5e4c1d3013e345187`;
ordinary next build: `vYUR516yeRL9ZO1A1N9gu` (15.223 seconds).
that live composition includes main through `cd0e43042038`.

the integration qualification began at `531dd909a7c4`, incorporating main
`7bc7c8a13d7f`. backend, migrations and transport are unchanged through the final
application; 430 archived backend files were hash-checked before the remote
runtime identity was aligned. affected browser interaction, layout and corpus
paints ran on the final build. receipts retain their actual source identities.

the later [release composition receipt](verification/suggestions/release-composition.json)
records integration with main `05d85a7e486b`: preserve toolbar/suggestions
composition and book-reader repair contracts; add final invalidation at fresh
stored-epub reprocessing, changed contributor repair and changed reader repair.
reader changed apply advances the revision once; unchanged/refused work does not.
independent source review and `./scripts/test` cover that delta; no new runtime
proof is claimed. the coordinator will qualify the exact combined release.

the cutover uses snake_case/null wire revision 2 and migration `0287` after
canonical `0286`. the small local database migrated from empty; the remote copy
migrated normally from genuine canonical `0277` to `0287` in 125.5 seconds.
the earlier unreleased suggestions databases stamped `0279` are preserved,
unchanged. their ancestry differs from main's `0279`: never stamp or upgrade them
into that chain. deployment still requires matching api/worker/web and the normal
migration controller with a verified release backup. native and extension builds
must also carry wire revision 2; native gradle derives it from generated web
wire types. old native builds need replacement, not just a webview reload.

## current integration proof

ranking runs on the existing fenced background queue. get/view hydrate bounded,
currently eligible refs without ranking. quick reads retain their direct owner.
the [specification](suggestions-plan.md) owns requirements and explicit costs;
the [module](modules/suggestions.md) owns the operational contract.

| boundary | observed proof |
|---|---|
| api and authority | 19 checks cover nullable envelopes, conditional admission, malformed refs, current membership, authenticated streams, role loss, four-route membership loss and restoration. |
| durable work | genuine cold/null responses; coalesced admission; two ordinary fenced publication generations for all three destinations; clear pointers; old explicit requests admit no successor; a completed stale execution cannot publish. |
| source commits | 23 writer cases, 17 committed revision transactions, zero domain sql after the counter update. reader generation/cursor lock overlap rejects the stale cursor. settled source identities and unchanged-anchor heartbeats stay quiet; fresh absolute-command resends may invalidate conservatively. |
| order and additions | cold completion auto-installs; adopted empty output stages later replacements; explicit adoption preserves focus. lectern, named and default-library additions remove/refill locally while rereads are held. a lost lectern acknowledgement retains recovery; a real hud check acknowledgement removes/refills in 14 ms. |
| independent acquisition | a held first entry read misses the existing 500 ms bootstrap budget without discarding metadata/suggestions seeds; filtered entries cannot consume the canonical seed; later pagination keeps completed rows visible. |
| delivery | real header/body stalls, early drops and retry waits share ten seconds; caller abort remains `AbortError`. the bff streams its first body byte before a held remainder, then aborts at ten seconds. lost refresh acknowledgement sends one command. ordinary read and sse controls survive beyond ten seconds. |
| content and input | final built keyboard/focus checks, native pointer admission, 320 px and 200% text pass. the native pointer check waits only two stable animation frames. an earlier automated auto-scroll miss remains recorded with no established product cause; no speculative layout patch was made. |

current sanitized receipts: [backend](verification/suggestions/integration-backend.json),
[source commits](verification/suggestions/integration-inputs.json),
[input inventory](verification/suggestions/inputs-inventory.md),
[frontend and delivery](verification/suggestions/integration-frontend.json).
these are observations, not executable tests.

## serving cost and ranking

the owned remote copy contains 766 media and 717,006 embeddings. postgres has a
512 mib limit, 64 mib shared buffers and jit disabled; api and worker each have
a 448 mib limit. authentication uses an ordinary invitation, password login,
verified jwt and `/me`. remote dispatch restricts the normal `JobWorker` and
`ChildExecutor` to suggestions so copied historical provider jobs never run.
the separate small local stack proves the unmodified ordinary worker entrypoint.

20 sequential authenticated reads and three concurrent reads per destination:

| destination | api p95 | concurrent maximum | pool | final browser paint, ms |
|---|---:|---:|---:|---|
| lectern | 129 ms | 166 ms | 23 | 348, 351, 342 |
| named library | 126 ms | 120 ms | 5 | 379, 444, 401 |
| default library | 96 ms | 110 ms | 0 | 683, 435, 423 |

browser measurement covers each fresh document's time origin through rendered
active-result geometry and the second animation frame; locator polling is
excluded. all nine meet one second, with zero page errors.

80-ref views preserve order while both embedding and graph relations hold
exclusive locks. the first ssh-bridged lectern series had p95 **562 ms**, retained
in the receipt. an origin-loopback control measured 74 ms lectern and 94 ms named
library p95, with concurrent maximum 141 ms. this distinguishes origin serving
cost from the observed bridge tail; it does not erase that tail. traced get/view
paths issue 13 lectern, 15 named or 7 empty-default statements and acquire neither
embeddings nor graph data.

independent main and integrated rankers use one exported snapshot: first ten
match for all destinations; quick reads are byte-identical (five rows). current
published pools are naturally 23/5/0, with no padding. current 80-ref view proof
uses eligible real corpus media, independently of publication width. background
ranking still takes seconds; no queue completion deadline is claimed.

## historical red green refactor proof

the original campaign qualified `2a856b824e22`, build `JCBY1ucZaC5-ri1ZsaC_m`,
on the earlier branch's `0279` schema. it exposed behavioral reds independently:
reads blocked on real embedding locks, missing empty/loading content, retained
accepted rows under held reads and hidden full-capacity suggestions. later reds
exposed publication discovery through `/view`, stale capacity, default-library
command ownership and coupled bootstrap seeds; each was repaired at its owner.

its [backend](verification/suggestions/backend.json),
[source/corpus](verification/suggestions/inputs-and-corpus.json),
[frontend](verification/suggestions/frontend.json) and
[transport](verification/suggestions/transport.json) receipts retain those
identities. they establish the original mixed 80-ref publication, concurrent
first registration/snapshot races, three failed attempts, dead-work diagnosis
and same-job repair, reclaimed-claim fencing, 13 stream cases and 29 interaction
cases. these broader proofs were not falsely relabeled as rerun on `0287`;
current integration checks cover the changed contracts and owners.

## limits and closure

- source commits briefly serialize on one global counter; invalidation is broad.
  relevance may age; authority and eligibility are checked at each read snapshot.
  active destinations own refresh; dead work requires same-job live repair.
- hidden-document and changed-browser-clock branches are source-reviewed.
  actual inactive-pane disposal and naturally aged clean publications were
  exercised in the original campaign. no operating-system kill during ranking
  is claimed.
- ten-second delivery protection is limited to suggestions. the wider
  [ordinary-read deadline issue](tickets/browser-read-deadline-does-not-cover-response-body.md)
  remains open. inherited built-next cancellation logging is recorded in the
  [existing abort ticket](tickets/node-middleware-aborted-body-rejection.md);
  no global exception suppression was added.
- deleting the requested temporary tests removes future automated regression
  detection. the unchanged `./scripts/test` remains the sole permanent gate.

the final [static receipt](verification/suggestions/integration-static.json)
records verification after temporary test deletion. original static and cleanup
receipts remain historical. current [local cleanup](verification/suggestions/integration-cleanup-local.json)
and [remote cleanup](verification/suggestions/integration-cleanup-remote.json)
record exact ownership checks, stopped services and deletion of temporary tests,
on-disk fixtures, credentials, profiles, relays, dependencies and build copies.
all four task volumes and their data remain; storage containers are stopped and
retained. normal auth startup replaced its old container while preserving the
same volume and prior account. canonical qualification databases remain beside
the frozen old-branch databases. no prune, reset or production operation occurred.
automatic pr preview checks are separate from production rollout.
