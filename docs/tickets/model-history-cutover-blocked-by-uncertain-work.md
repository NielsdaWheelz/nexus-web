# model history cutover lacks an uncertain-work disposition

status: open; release blocker
origin: 2026-09-27 combined-release plan, `fbd08ba68`
area: migration 0246

`migrations/alembic/versions/0246_latest_model_history_cutover.py:72-95`
aborts for every nonterminal chat run or outcome-null chat generation; lines
264-279 also reject unsettled retained-domain generations. the reported old
codex run reached uncertain dispatch and was left suspended. the approved
model plan permits abandoning old paid work during its history reset, but no
executable, audited transition currently makes that run pass the preflight.
its current production database state needs a fresh census.

read-only production census on 2026-09-27: deployed source
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database revision `0241`.
run `ac2b162e-0bb1-4b66-90f5-a9aaec0b3f22` is `running` while its job
is `dead` after three attempts. two chat generations have dispatched model
turns with no terminal; one belongs to this run, the other to a terminal run.
neither has recorded tool positions. a dead job and absent tool positions do
not prove the native/provider turn stopped or that no external effect occurred.

the 2026-09-27 candidate adds `python/nexus/model_cutover_preflight.py` and
requires its reviewed snapshot in `deploy/hetzner/release.py` before crossing
`0246`. the controller rejects a missing or malformed input before shutdown
and compares exact identities after writers and host stop. this guards drift;
it does not dispose of these generations or satisfy `0246`.

before release, stop writers and native processes, revoke grants, take the
verified backup and inventory exact run/job/generation/effect identities.
settle with real retained evidence where possible. otherwise the model-cutover
owner must define and implement an explicitly reviewed, allowlisted
abandonment transition for the approved reset that preserves the uncertainty
and domain effects/undo without inventing a terminal or redispatching work.
prove the exact migration on a copy containing the blocker; any unhandled
owner row or unknown effect stops the release.
