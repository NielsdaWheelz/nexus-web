# pre-pr-243 product restoration

status: restoration merged; production qualification in progress
origin: 2026-09-14 restoration, reconciled with merged pr #254

## identities and invariant

- coherent product source: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
- inverse merge: `1b2a7a38174a55075df3d3ee258a91dcbfc0d64a`, first parent selected.
- initial target: `a1f59a755c91bdc22e77e33c12b93dde829a8e6e`.
- updated target: `d1b9bf49b33d29cef6e4c3c1c6403eef450d77c1`, merged pr #254.
- branch: `codex/restore-pre-243-product`.

reverse the bridge's net patch; do not replay historical commits. merge updated
main into that restoration. preserve its ancestry, including all 57 bridge-only
and 21 original post-bridge commits and the five commits delivered by #254.

the product, migrations, and assets match the coherent source by git blob and
mode, including absent paths, except reviewed later fixes and necessary generated
assets. ci and tests follow #254's direct deterministic check. deployment is
reconciled semantically, retaining immutable source identity, stopped-writer
migration safety, health, recovery, and production verification. every unequal
path is listed in the [exception allowlist](pre-243-restoration-exceptions.json).
this list is a one-time restoration audit, not test selection or policy machinery.

## validation contract and tradeoff

source/git work happens on the macbook. push the reconciled branch, then run only
`./scripts/test` without arguments from a fresh clean linux devbox checkout.
record the machine, exact source sha, command, outcome, elapsed time, and peak
process memory in the pr. these ordinary logs are not a new receipt framework.

#254 deliberately excludes browser/e2e, real-service integration, hosted
providers, android automation, release simulations, planners, policy engines,
faults, sensitivity, and scheduled suites. remove equivalents restored from
98a8b63bf0 as well as the paths already removed by #254. retain fast deterministic
units and the cheap single-head migration graph check. extend the explicit
static file list to the restored codex application; do not add a second gate.

this trades automated cross-process/browser/device/migration confidence for a
small bounded check. a green result is not deployment qualification. the source
ends at **db0229**, not db0228. retain the shared-agent dependency pins; the old
lazy-provider implementation is incompatible and no new memory claim is made.
locked test dependency removal requires regeneration of the offline reader asset
manifest through its existing build owner, never hand-edited hashes.

## release boundary

the original task stopped at the restoration pr. subsequent user instructions
authorized merge, immutable image publication, frontend staging and a conditional
production release. pr #255 merged as
`634206213c50f9cdfcecfae8c8f7efc331ddec48`; the historical import-code repair in
pr #256 merged as `c71953c3bd5e851dc742fb967ecedd8c29551e8d`; the historical
reader-text repair in pr #257 merged as
`f75a7aa0d77ae83c6d95ca6784b77afd14cf1ae6`. #254 was already
merged and its direct-check design remains incorporated.

before cutover, rehearse the exact populated db0215-to-db0229 chain, obtain
explicit acceptance of measured history losses, verify stopped-writer backups,
qualify exact image/codex memory and host capacity, prove recovery, and complete
production verification. after data mutation or backend activation recovery is
forward-only. the user will check android manually after cutover. production
remains on db0215 until these release prerequisites pass; a green unit suite
does not authorize irreversible data mutation.

## historical validation and cleanup

before #254 merged, dev-server completed a disposable populated migration chain
at `eb07b3851085a060bade1e282ce7683e65b0d3b0`: run `5b88cb536d729ae9`, 152.907 s,
1,029 mib aggregate owned peak memory; injected cursor defect failed and intact
migration passed. migration files were unchanged at that head. this is historical evidence,
not a pass for the reconciled head. the old proof source and harness are removed
under #254. the earlier full/pr attempts did not complete; their failures and
partial results are recorded with their original shas in the pr.

the user authorized inactive rootless docker build cache and bun download-cache
removal, then separately approved exactly 22 unused devbox images. all 22 planned
image ids were removed without force or global image pruning; current-main api
and worker images, all seven containers and four volumes were retained. free
space increased from 8,495,247,360 to 17,580,036,096 bytes in the image-cleanup
snapshot. plan sha256:
`4e9ac884f2bb8c6257bf2fdd914d905ed389801e15fb3ad4dfe069f7d109a324`.
removed cache/images may require rebuilding or downloading. no production
resource or dirty primary source worktree was changed.

a temporary mac linux vm was cloned during the earlier host-direction changes,
then stopped and deleted without running tests/builds. it provides no evidence.

## review ledgers

- [all 57 bridge goals](pre-243-bridge-goal-ledger.md).
- [original conflict and 21 post-bridge commit audit](pre-243-conflict-ledger.md).
- [updated-main merge and cleanup](pre-243-main-merge-ledger.md).
- [migration hazards and later release requirements](pre-243-migration-ledger.md).
- [exact exception allowlist](pre-243-restoration-exceptions.json).
