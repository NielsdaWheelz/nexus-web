# final combined candidate still needs qualification

- status: open; delivery checkpoint committed, combined qualification pending
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: release process / evidence identity

## current state

the integrated implementation, reviewer fixes and upstream reconciliation are
committed through `318747fb5c` on `codex/bounded-workspace`, draft pr #250.
all continuing work uses that delivery worktree and branch. earlier isolated
receipts remain historical evidence; they do not qualify the combined candidate.

## original finding

`HEAD` on `codex/bounded-workspace` is still the base commit
`7fa89b88c8342bca9edfb46a6d20053c49555fb2`, and `git status --porcelain | wc -l`
reports ~740 dirty paths with nothing committed. the tree also mutates during
review: the fault manifest's drift set changed twice within two minutes of one
audit.

consequences, all observed rather than predicted:

- `prove` refuses to run: receipts `de076f74f7765a05` (client dossier :163-164),
  `b44b8008c8fe390d` and `0a0777a4e78a812b` (publication dossier) all stop with
  `sensitivity requires a clean committed checkout`.
- the qualification receipts that matter (`0103cec1174b644e`, `bd1dc4955ce312e3`,
  `c243cd943a90b130`) were taken against a frozen **dirty-source digest**, which
  the runtime dossier itself labels "provisional source evidence, not a clean
  release-image qualification" (:49-51, :157-163).
- pinned-proof checkpoints live on separate branches (`codex/bounded-web-proof`,
  `codex/bounded-native-proof`), not on the candidate, so no receipt's source
  identity is the candidate's.

each new receipt invalidates the previous ones' source identity, so the evidence
set cannot converge. gate g's "exact candidate passes required `pr`/`full`/native
release lanes" is not merely unmet — it is unreachable.

## prerequisites

none. the spec's release checkpoints already describe the commit sequence.

## proposed fix

freeze the branch into the bounded commits the spec names — incident containment
+ admission + pending work; then publication/query/view; then native packages —
and re-run the declared fault portfolio and the capacity scenario against each
committed candidate sha before any of them is called qualified.

## acceptance

every receipt cited as acceptance names a committed sha that exists on the
candidate branch, and `./scripts/test prove` runs rather than refusing.
