# android rejects native-valid zero-length chapters

status: open · origin: 2026-10-04 sol native-contract source audit, `921e69daa8936d75f066e39aef66bdc560b6ae8a` · area: native player / chapter contract

`migrations/alembic/versions/0236_baseline_schema.sql:2003` permits chapter
`end >= start`; `python/nexus/services/podcasts/feed.py:295` preserves equality.
`python/nexus/schemas/consumption.py:24–27` has independent nonnegative start/end
bounds, and web `apps/web/src/lib/lectern/contract.ts:406–425` accepts equality.
android `apps/android/app/src/main/java/app/nexus/android/playback/PlayerProtocol.kt:941–946`
requires `end > start`, rejecting that native-valid descriptor. no device/runtime
failure was observed.

first establish canonical chapter-end/time-unit semantics from the database,
model, producer and all playback consumers: point markers versus intervals is a
real decision. align the responsible parser/producer; do not blindly drop the
chapter, rewrite its end to absent, or replace the protocol. this is separate
from the title-unit issue and the current output-owner cut.

resolved when: actual native-produced equal-end chapters and the native parser
agree under the chosen contract; live seeking/ordering remain correct; negative
and end-before-start inputs and other drift checks remain rejected. require full
consumer/source closure and proportional finite proof. source pins:
`/tmp/nexus-lectern-adjacent-grammar-source-findings.json`.
