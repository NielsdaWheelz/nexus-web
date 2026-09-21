# quick reads verification

date: 2026-09-21
branch: `feat/quick-reads`; baseline: `2b4a6ace67`
contract: [quick reads](quick-reads.md)

final gate: `./scripts/test` passed after all application edits: formatting/lint,
python and typescript checks, packaged offline-reader build, css checks and the
single migration head `0240`. `git diff --check` passed.

## method

independent duration, resonance and frontend implementation tracks; cross-review
of contracts, candidate caps, pagination, deletions and lifecycle ownership.
manual service/sql checks used a disposable actual-corpus clone: 702 media,
472 visible default-library entries, schema `0240`. fixture transactions rolled
back. browser checks used normal local authentication and the actual api against
that clone. no production writes, new test harness or schema migration.

## observed behavior

| acceptance | evidence |
| --- | --- |
| section and navigation | desktop and 390 px mobile: queue → quick reads → at hand; no horizontal overflow, related copy, expansion or dedicated add button. opening a quick row navigated without changing the nine-item queue; opened-resource links/synapses remained available. |
| candidate acquisition | 25 newer long candidates ahead of six short candidates did not starve quick reads. returned five distinct items. all five remained at the actual 2,000-item queue cap, including already-queued items; at hand correctly became empty. |
| cursor meaning | no/empty cursor used full duration; p=.8 → .2 changed remainder from 200 → 800 seconds while high-water stayed .8. positioned-null and positioned pdf were unknown. `SetUnread` preserved cursor and remainder. completed-then-rewound media remained finished and excluded. |
| cutoff/readiness | 599.9 seconds qualified and displayed 10 minutes; 600 did not qualify. zero remained zero and did not qualify. pending readiness and visibility tombstones excluded candidates. no eligible documents returned an empty list. |
| library pagination | both directions traversed all 472 entries in ten pages, exactly matching unpaged sql order: no duplicates, 15 repeated durations, all 37 unknowns last. browser sort selector offered both directions; choosing longest fetched descending entries and displayed the longest works first. canonical/title, in-progress, unfinished/type and unfiled views loaded. accepted cursor writes made old continuations return `409 E_COLLECTION_CHANGED`. |
| facts and cutover | exact factual slate fields; obsolete reason rejected. episode timestamp hydrated as its utc calendar date. quick endpoint returned 200, unauthenticated 401, unexpected query 400; retired related endpoint returned 404. runtime search found no retired consumer. |
| refresh and focus | pane return refreshed quick reads. scrolling the article, saving its cursor and returning changed its label from about 10 to about 8 minutes. marking the last result finished produced the empty state; focus moved to the section instead of being stranded on the document body. browser offline mode produced a distinct error with retry; returning online and retrying restored the article link. |

## plans and cost

duration relation: 25 ms; remaining first page: 103 ms. quick service: 925 ms,
16 bounded statements, 368 ms database time. plans used stored counts, without
request-time text scanning or per-result queries. no persistent cache/index added.

the disposable clone omitted large index/child tables to fit local disk. the four
captured semantic queries and graph query were therefore also executed in
read-only transactions against the complete original snapshot: 708,044 embeddings.
semantic execution: 409 ms cold, then 28–42 ms; 110/0/109/110 candidates, all with
positive remainder below 600 seconds. eligibility was inside the 400-chunk cap.
the existing semantic threshold admitted none; graph execution was 324 ms.
the source snapshot stayed at schema `0230`, with relevant relations unchanged;
no source data/schema writes. these timings describe this corpus, not scale limits.

## review corrections and limits

- removed a runtime import cycle by placing queryable readiness in its capability
  owner, independent of media mutation/indexing imports. api startup verified.
- repaired focus loss observed when a menu action removed the final quick row.
- corrected cached default-order duration freshness through `durationRevision` in
  the existing consumption snapshot. accepted cursor saves/resets advance it;
  every library view captures and compares it. independent review traced active,
  restored and in-flight reads. publication also survives reader teardown; stale
  local generations cannot install reader state. audio heartbeats retain their
  previous scope.
- checked publication invalidation through existing revision owners; did not replay
  complete re-ingestion. audio formatting and authored reorder paths were reviewed
  for unchanged behavior; no unrelated playback or ingest journey replay.
- unrelated pre-existing gaps remain recorded: [status-only library row freshness](tickets/library-status-only-consumption-stays-stale.md)
  and [deleted documentation references](tickets/collection-contract-docs-reference-deleted-cutovers.md).

raw local receipts and screenshots are under `/tmp/nexus-quick-reads-*` on the
implementation host; this document preserves the relevant observations.
