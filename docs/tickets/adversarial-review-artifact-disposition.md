# Decide the disposition of the untracked generation-cutover adversarial review

**Status:** open (decision needed: archive or drop the copied review document)
**Origin:** PR #203 takeover, 2026-09-06
**Area:** documentation; stale worktree hygiene

## What exists

`/private/var/tmp/nexus-pr203-review.cs8I1R/docs/cutovers/generation-backends-hard-cutover-adversarial-review.md`
is an untracked 356 KB, 1272-line report dated 2026-08-31 produced by a
12-agent review of the spec as it stood on branch `codex/pr203-adversarial-review`
(4 fact-checkers, 1 consistency auditor, 4 SME councils, 3 adversarial
verifiers; the `llm-calling` pin it checked against was `a5d9c8e`). Tally: 124 findings pooled, 105 surviving verification (8 blocker,
32 major, 49 minor, 16 note), 7 refuted, 12 merged; 115 spec claims verified
true. Its five blocker themes (fabricated legacy-ID translation table,
orphaned tool-position grammar, unspecified write-grant consent surface,
BASE red plan unable to produce accepted evidence, nonexistent named gates)
were all addressed by the PR's later commits ("docs: close generation cutover
review findings" and the following spec rewrites); the 2026-09-06 acceptance
audit re-derived the surviving criteria from code and found no open blocker
from that list.

The same worktree also holds a `python/.nexus-test/` directory (generated,
must never be committed) and tracked modifications that are byte-identical to
what the PR later merged; nothing else there is unique.

## Why it was not committed

The report reviews a superseded revision of the spec, so committing it as-is
would contradict the supersession and documentation-consistency criteria. The
residue proof (`test_generation_cutover_residue.py`) treats
`*-adversarial-review.md` under `docs/cutovers/` as a historical record and
skips it, so committing is possible, but only with a preamble that dates it,
names the spec revision it reviewed, and states that its findings are closed.

## Options

1. Archive: add the preamble above and commit it as
   `docs/cutovers/generation-backends-hard-cutover-adversarial-review.md`,
   keeping it as historical evidence beside the change report.
2. Discard: remove the stale worktree
   (`git worktree remove --force /private/var/tmp/nexus-pr203-review.cs8I1R`)
   and delete branch `codex/pr203-adversarial-review`; the closed findings are
   already reflected in the spec and PR history.

Recommendation: option 2 unless the review's refuted-findings section is wanted
as a record of objections that must not be re-raised, in which case option 1
with the preamble.

## Cleanup done 2026-09-06

The eight stale PR #203 worktrees (fence-proof.A8JuPE, persisted-sensitivity-final,
proof.KAnhH6, proof.pmOByV, review.cs8I1R, squash.xSZ5Gq, token-sensitivity,
`.ol1W8I`) were removed with `git worktree remove --force`, and their local
branches (`codex/pr203-final`, `codex/pr203-final-next`,
`codex/pr203-storage-persisted-sensitivity-final`,
`codex/pr203-storage-token-sensitivity`, `codex/pr203-adversarial-review`, and
the stale local `codex/codex-personal-generation-hard-cutover`) were deleted.
None of their compose stacks were running.

Before removal the review document was copied byte-for-byte (356056 bytes) to
the session scratchpad:
`/private/tmp/claude-501/-Users-nnandal-Documents-code-nexus-web/a69ceec4-21c1-41bc-95d5-ada831ac3735/scratchpad/generation-backends-hard-cutover-adversarial-review-2026-08-31.md`.
That directory is temporary, so the archive-or-drop decision above has to be
taken before it ages out; option 1 now means committing that copy with the
dating preamble, option 2 means doing nothing.

## Second cleanup pass 2026-09-06

Also removed on the owner's confirmation: the orphaned docker volume sets of the
eight removed worktrees and of five further compose projects with no owning
runtime record or container; every unregistered `nexus-pr203-*` leftover under
`/private/var/tmp/` (bundles whose heads are all inside PR #203, the
`nexus-pr203-vm-source` clone at 0c651e50, evidence, CI, focus and script
files); the PR #194, #197 and #204 leftovers there (worktrees, bundles, build
caches; all three PRs merged, none held a dirty or unpushed repository); the
three agency-managed worktrees for merged branches and the four merged
`agency/*` local branches. The agency daemon was not running and its own
metadata under Application Support was left as is.

Deliberately left in place: the running `nexus-test-81b7d2e67326829d` stack,
which belongs to the `nexus-release-0.2.14` worktree (started 2026-09-06); the
`nexus-pr203-runner` container and its three cache volumes (still needed for
governed runs on the takeover worktree); the `nexus_pr194*`/`nexus-pr193-*`
runner-cache volumes and any stopped runner containers behind them; the
`/private/var/tmp/nexus-ci-*` hosted-CI artifact downloads and
`nexus-catalog.*` directories. Those are the next cleanup candidates.
