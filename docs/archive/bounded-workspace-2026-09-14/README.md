# bounded workspace preservation

status: paused for replanning, 2026-09-14; no implementation discarded or merged.
delivery source: `8f2e78c86d53808af8545f4c8d96c9429aa23a49` on `codex/bounded-workspace`.
[replacement plan](../../cutovers/production-crash-replacement-plan.md) · [evidence audit](../../cutovers/bounded-workspace-evidence-audit.md).

this source retains the consolidated implementation and claude fixes. the files
below preserve useful material that previously lived only in ignored run folders,
`/tmp`, upstream work or historical proof/review worktrees. source worktrees and
original evidence remain untouched. nothing in these archives is active code.

| archive | contents |
|---|---|
| [evidence.tar.gz](evidence.tar.gz) | 685 byte-identical summaries and contexts; all 941 indexed artifact references resolved to verified bytes, deduplicated by hash; downloaded ci evidence/reports; cancellation log/status and pre-close pr metadata. `artifact-links.json` maps each original receipt/path to its blob. |
| [additional-run-evidence.tar.gz](additional-run-evidence.tar.gz) | 502 other historical run summaries/contexts and their available referenced files, including runs not cited in the dossiers. all 870 located references were preserved; no missing references. these do not change the 685-row index or its verdicts. |
| [drafts.tar.gz](drafts.tar.gz) | 1,093 retained source drafts, patches, inventories, reviews, design notes and counterfactuals. includes rejected/superseded candidates; read their adjacent disposition before reuse. |
| [worktree-snapshots.tar.gz](worktree-snapshots.tar.gz) | tracked deltas against the delivery source and untracked source files from ten historical task worktrees; the upstream provider-boundary checkout's tracked source. not a merged implementation. |
| [manifest.json](manifest.json) | archive and member byte counts/sha256, original locations, and worktree reconstruction bases. |

verification: every archive/member was reread and matched its recorded hash;
every indexed summary/context reproduced its original hash and all 941 indexed
artifact references resolved. the index itself remains at
[testdata/evidence/bounded-workspace-receipts.json](../../../testdata/evidence/bounded-workspace-receipts.json).

inspect with `tar -tzf`; extract only into a new empty directory, never over the
delivery tree. historical tracked state reconstructs by applying its
`tracked.patch` to the named base, then adding its `untracked/` files. this is
recovery documentation, not an instruction to resume or apply the patches.

trade-off: the four archives add approximately 27.0 mb to git history so this
one-time preservation does not depend on temporary files or expiring ci uploads.
this is not a new ongoing artifact-storage mechanism.

excluded: ignored dependencies, caches, credentials and mutable runtime resource
directories. no original files were deleted. prior run artifacts are historical
evidence, not qualification of the final source. byte verification is an archive
integrity check; no product test or experiment ran during this pause.
