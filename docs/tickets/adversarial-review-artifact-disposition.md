# Decide the disposition of the untracked generation-cutover adversarial review

**Status:** open (decision needed)
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

## Also stale in the same location

Eight pre-existing PR #203 worktrees registered on the primary checkout sit
at superseded commits (`git worktree list`, 2026-09-06):

| Worktree under `/private/var/tmp/` | Head |
|---|---|
| `nexus-pr203-fence-proof.A8JuPE/worktree` | d08fb205 (detached) |
| `nexus-pr203-persisted-sensitivity-final` | 49fa8cd3 `codex/pr203-storage-persisted-sensitivity-final` |
| `nexus-pr203-proof.KAnhH6/worktree` | 12014d36 (detached) |
| `nexus-pr203-proof.pmOByV` | b37eded8 (detached) |
| `nexus-pr203-review.cs8I1R` | 85c437b5 `codex/pr203-adversarial-review` (dirty, see above) |
| `nexus-pr203-squash.xSZ5Gq/worktree` | f7e7601b `codex/pr203-final` |
| `nexus-pr203-token-sensitivity` | 2e76624c `codex/pr203-storage-token-sensitivity` |
| `nexus-pr203.ol1W8I` | 1588064b `codex/codex-personal-generation-hard-cutover` (stale checkout of the PR branch) |

The two live worktrees (`nexus-pr203-takeover`, `nexus-pr203-strip`, both at
b8f63d8f) are not stale. The same directory also holds unregistered leftovers
(`nexus-pr203-*.bundle`, `nexus-pr203-focus-*.exit`/`.log`, `nexus-pr203-ci*`,
`nexus-pr203-evidence`, a `nexus-pr203-vm-source` clone at 0c651e50, and two
fault-proof zsh scripts). None were touched by the takeover. Removing them
frees disk and avoids the macOS temp cleaner corrupting a worktree later.
