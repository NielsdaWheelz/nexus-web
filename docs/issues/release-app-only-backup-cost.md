# application-only release overhead

open release-owner follow-up. the full-cohort path is disproportionate for routine
single-user runtime fixes: `release.py:1030–1107` pulls/restarts the source-bound
cohort, installs inputs, backs up, converges postgres and invokes migration;
`deploy.sh` pairs the web artifact. the same-schema 37d query repair took about
9m41s, including a fresh verified 1.56 gb archive. recent backup/full verification
alone took roughly six minutes. this is release work, not a repeated test suite.

backup state is keyed by candidate sha (`release.py:462–488`). completed same-attempt
receipt reuse is qualified; cross-release reuse is not. unchanged database
identity/schema and an archive hash do not prove current rows unchanged.

an explicit runtime-only path must prove schema/data-format/environment/resource
compatibility, retain postgres, use a sufficiently fresh verified backup under a
defined recovery contract, and permit compatible runtime rollback. storage and
postgres binary/config changes retain the strict migration path. no safe shorter
path exists yet; unchanged alembic head alone is insufficient.

the trade-off is an older recovery point if runtime code damages data; reverting
code cannot undo those writes. resolve when the existing controller enforces
that classification/freshness contract and bounded refusal/rollback behavior is
verified. current release/nightly policy and waived backup-window enforcement
are unchanged. full timing/recovery receipts remain privately retained.
