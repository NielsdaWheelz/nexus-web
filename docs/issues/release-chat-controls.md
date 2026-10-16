# release chat controls

status: pending canonical rollout
origin: 2026-10-16 approved chat control specification
area: generation catalog / client pairing

the controls require catalog fields `mode`, `effort` and `effort_order` and
introduce wire revision 4. runtime pin `2586d82719984d17b9cf26e3f5a0864de18b0b39`
and kernel pin `e28cbef3eca8a88e1f143f48d3042485b334cf6c` are one dependency
cohort. the existing contained codex host requires no change. the web must not
run against the old catalog or infer missing fields.

the release owner pairs api, web, extension and apk builds under the existing
revision contract, then reloads old browser
tabs. check that no unresolved send is discarded across that reload. this
requires no database migration and does not enter the separate book release.
the dependent viewer work introduces wire revision 5 and its own migration;
release that combined build under its final revision, never a mixed cohort.

acceptance: the paired build renders real model/mode/effort facts, an old
client is refused by the existing wire gate, and a disposable live generation
records the exact selection shown by the controls. rollout remains with the
canonical release owner.
