# imports reads

status: read boundary implemented; live qualification and final static gate passed.
owner: `services/imports.py` classifies and reads; `schemas/imports.py` and `import_history.py` own output contracts; the imports pane presents those facts.

## behavior

four authenticated repeatable-read routes return their existing models through `Data`: `/imports/summary` (`ImportSummary`), `/imports` (`ImportPage`), `/imports/{ref}` (`ImportDetail`), and `/imports/{ref}/history` (`HistoryPage`). preserve existing snake-case json, always-sent fields, tagged presence, datetimes, arrays and valid serializer bytes. there are no nullable/factory output defaults or custom serializers in this graph.

a published upload keeps its `upload:<handle>` identity; media visibility and import ownership remain separate. summary counts are global; filtered pages retain current classification/stage grouping, normalized-query cursor binding and limits. history is newest first, retaining all 22 upload/source/index fact variants, recovery/baseline subvariants and full/partial coverage. detail includes current readiness and publication-generation source issues. services keep existing viewer/shared-media filters and the same recovery policies.

`ImportPage` owns four existing consistency checks: item count cannot exceed matched count; refs are unique; grouped counts cannot exceed matched count; a continuing page is nonempty. `ImportDetail` owns issue-count/list equality. impossible construction raises `ValueError` before serialization; these checks formerly ran after transport in the browser.

## representation and consumers

web reads use generated `ApiJson`/component types and native snake-case fields. `importsClient.ts` adapts only branded import/media refs, retaining invalid-identity classification as `E_INVALID_RESPONSE`. status, badge, stage grouping and inspector history use the existing presentation owners. no camel read replica or 22-case browser history decoder remains.

the list/history hooks bridge native data to shared `CursorPage`; memoization follows the underlying page identity. unchanged row rereads preserve appended pages; query changes reset continuation. the provider's observation, last-good rows, polling, failures and retry remain their existing view-state contracts.

url/filter option catalogs remain genuine input ingress. the three recovery commands retain their request/admission/mutation-id behavior. [action snapshots](resource-actions.md) use generated camel-case media recovery offers; upload offers remain outside that union. upload capabilities, generation fencing, invalidation and persisted journals keep their existing owners.

current writers guarantee the retired scalar checks: owner-allocated uuids; positive upload generations/attempt numbers; nonnegative index revisions and pdf/epub counts; literal counted units; publication's 10,000-issue bound; nonempty signed continuation cursors. shared persisted history schemas are not tightened for this read cutover.

## qualification and limits

candidate qualification: 46 real authenticated reads preserve baseline results, normalizing only moving `observed_at` and error request ids; 66 frozen-model envelopes preserve exact serializer bytes. actual old/new presentation outputs match across 25 rows, 52 history entries, all 22 facts and 15 nested alternatives. five malformed relational constructions reject at their model owner; camel action snapshots preserve accepted offers and upload refusal. unobserved history branches are declared model fixtures.

real browser views, inspector and empty results match the baseline. signed list/history continuations survive unchanged five-second rereads; filter changes reset them. three recovery admissions return 202, replay without new rows and reject changed replay payloads with 409; queue and journal identity were observed. receipts: `/tmp/nexus-imports-{candidate-browser,candidate-continuation,recovery}-receipt.json`; presentation conservation: `/tmp/nexus-imports-presentation-receipt.json` (retained hash/count summary). no provider, worker, storage upload or background completion claim. this partial read cut removes 911 production lines, excluding generated wire and docs; remaining ingestion/imports reauthoring stays open.
