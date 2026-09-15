# pre-pr-243 product restoration

status: in progress; no merge or production authorization
origin: 2026-09-14 restoration

## identities and invariant

- target: `a1f59a755c91bdc22e77e33c12b93dde829a8e6e`, fetched origin/main.
- inverse merge: `1b2a7a38174a55075df3d3ee258a91dcbfc0d64a`, first parent selected.
- coherent product source: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
- august reference: `7e8fd48244b3b436965037738e05785bb4931be1`.
- branch: `codex/restore-pre-243-product`.
- local worktree: `/Users/nnandal/Documents/code/nexus-web-restoration`.

restore the inverse merge's net product tree. do not replay historical commits.
every ordinary path must have the same git blob and mode as the coherent source.
only explicitly listed post-bridge paths, reviewed bridge forward ports, and
restoration documentation/proofs may differ. absent paths count too.

origin/main still contains the bridge and its 21 descendants; no restoration
has landed. the bridge has 57 commits unique to its second-parent side. its
final tree includes fixes atop the august reference. the exact coherent source
ends at db0229, so validation must extend through that head.

## source-tree verification

from the clean candidate, compare `git ls-tree -r -z` entries for the coherent
source and candidate. the union of paths is compared by mode, object type and
blob id, including deleted and added paths. every unequal entry must be named
in one of the three explicit exception groups. check the declared post-bridge
path set against `git diff --name-only 1b2a7a3 a1f59a7`; it must match exactly.
check both the bridge and every commit in `1b2a7a3..a1f59a7` remain ancestors.
compare the 57 exact bridge-side commit ids with the disposition table. record
the candidate, tree id, counts and empty unexpected-path set in the pr receipt.

## scope and tradeoffs

- preserve all valid post-bridge goals against the restored architecture.
- keep the existing ci-simplification branch separate.
- preserve shared-agent/provider pins until restored worker memory is measured;
  the legacy lazy-provider pin is not an architecture-compatible default.
- add one populated migration chain proof; retain focused destructive-migration
  refusal and preservation proofs rather than duplicate their permutations.
- the devbox migration proof is synthetic and disposable. no production database,
  migration, deployment, image publication, vercel change, or merge is authorized.
- stop after opening one focused pr. subsequent release requires its own
  reviewed migration/data-loss disposition and exact artifact authorization.
- source and git work stay on the macbook. the latest instruction requires a
  fresh clean devbox checkout of the pushed exact sha for authoritative pr,
  migration, image/container, memory and capacity evidence. mac-only evidence
  cannot authorize merge or deployment.

## devbox cleanup

the temporary devbox worktree and branch were transferred with a clean
checksum comparison, then removed with all task-created temporary files.
the primary checkout's porcelain status and tracked binary diff remained
byte-identical to their initial snapshots. no devbox tests or services ran.
the user separately authorized deletion of inactive rootless docker builder
cache (reported reclamation: 6.396 gb) and the bun download cache. installed
dependencies, images, containers, volumes, and source worktrees were retained.
the final root filesystem had 10,932,879,360 bytes free. these disposable caches
will regenerate; this operational cleanup does not fix cache-retention policy.

## review ledgers

- [all 57 bridge goals](pre-243-bridge-goal-ledger.md).
- [14 post-bridge paths, nine conflicts, and 21 retained commits](pre-243-conflict-ledger.md).
- [db0215 through db0229, destructive effects, and later release requirements](pre-243-migration-ledger.md).
- [exact exception allowlist](pre-243-restoration-exceptions.json).
- [exact pr comparison limitations](pre-243-pr-sensitivity-matrix.md).

## validation and release boundary

run the complete repository-owned pr proof with
`NEXUS_TEST_BASE_SHA=a1f59a755c91bdc22e77e33c12b93dde829a8e6e` from a fresh clean
checkout of the pushed restoration sha. record that sha, the devbox identity,
the command, run id, result, memory/capacity, and artifact paths for every
receipt in the pr. earlier source inspection and macbook work are not runtime
proof. a failure or unavailable prerequisite remains a failure or not-run.

pr #254 currently points to `cb7e034204c92779cef7fca90834be8195295664` and is
excluded. retain it as design evidence. after restoration's separately gated
merge and deployment, recreate its small intended change from restored main;
rebasing its materially different ci/test tree is insufficient.

no test receipt is claimed by this specification. completed execution receipts
belong to the exact pr head; do not change committed source merely to insert
its own git identity into itself.

## additional explicit tradeoffs

- the restored docker builder pins bun 1.3.14. retain the bridge's exact-version
  admission goal at that restored version instead of downgrading to 1.3.10.
- absent-highlight recovery retains a copyable draft and requires reselection;
  the original creation promise cannot be retried. actual defects still surface.
- one trailing blank at the end of a restored reader browser proof is removed
  to satisfy whitespace validation; it is a declared test-only exception.
- preserving the baseline's source equality does not authorize its destructive
  migrations. backups and rehearsals do not themselves choose a disposition
  for intentionally deleted chat, generation, audit, and publication-date data.
- a temporary local linux vm was cloned while host instructions were changing,
  then stopped and deleted. it ran no test or build; the original stopped vm
  and docker desktop workload remained intact. it supplies no validation evidence.
- an explicit backend image workflow reuses the release-artifact capability to
  validate both images without staging an android release. it removes its exact
  containers and image tags. builder-cache retention remains a separately
  ticketed capacity defect; no shared cache pruning is embedded in the proof.
- successful worker/parser proofs retain their existing memory assertions and
  add durable measurements to the controller receipts. this adds observability,
  not a substitute budget or a legacy provider implementation.
