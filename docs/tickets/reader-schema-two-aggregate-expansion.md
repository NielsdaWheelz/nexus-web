status: open
origin: 2026-09-13 maximum-source table projection review
area: schema-2 package aggregate capacity

the supported schema-1 reader JSON limit is 64MiB; aggregate expanded package
limit is 512MiB and entry count is 4096 (`schemas/offline_reading_package.py`).
schema-2 explicit render nodes expand structural markup: an empty `<td></td>`
occupies 9 source bytes but its minimum closed Element record already exceeds
72 bytes, before per-cell table context, unit metadata and index references.
thus a large previously admitted empty-cell table can exceed the old aggregate
package limit even though every new unit satisfies its individual bounds.
this is a lower-bound capacity conflict, not a measured complete-source result.

prerequisite: finish the actual table member representation. run the producer
against maximum admitted schema-1 source shapes, retaining final encoded bytes,
member count and native staging/storage costs. choose a measured schema-2
aggregate contract or a smaller lossless representation; coordinate Python,
native verifier/converter and release admission. do not silently reject old
installed content, truncate cells or label unit bounds sufficient.

acceptance: every qualified legacy maximum converts to a truthful closed schema-2
package within the declared aggregate/member/manifest/disk bounds, including
the allowed source-plus-assets combination. exact producer/native conformance
and real device staging prove the chosen contract.
