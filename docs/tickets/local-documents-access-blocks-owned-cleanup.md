# local documents access blocks owned cleanup

status: open. origin: 2026-10-02 cleanup campaign, after pr #445. area: local workflow/host access.

macos blocks ordinary source reads under documents with `operation not permitted`, including `/Users/nnandal/Documents/code/nexus-web-writing-ack-slice-20261002/AGENTS.md`; git also reports `unable to read current working directory: operation not permitted` in the original repository. directory metadata remains readable. this is host access, not a product defect.

an unused owned checkout remains at `/Users/nnandal/Documents/code/nexus-web-writing-ack-slice-20261002`, on `cleanup/writing-acknowledgement`, base `af5d5c314af7bdec0cc189421fd95d18fa46714f`, with newly installed locked dependencies. current work continues in an independently verified clone under `/tmp`; no cleanup of the blocked checkout is claimed. evidence: `/tmp/nexus-writing-ack-setup-receipt.json`.

prerequisite: ordinary documents access restored. remove only that unused owned checkout and its local branch; preserve the original dirty main, peer worktrees, sessions and task db/auth. do not reset host permissions or substitute a product workaround.

acceptance: scoped checkout/branch removal verified after access returns; original dirty main and peers remain intact. delete this ticket and its register entry when resolved.
