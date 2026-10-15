# devbox disk reserve exhausted during book qualification

status: open; clone workloads held, no production effect
origin: 2026-10-15 book-repair coordinator, after cleanup main `43433c845`
area: shared devbox storage and disposable clone lifetime

the final read-only comparison after cancelling an unapplied fixture refused
before container creation: `run_article_index_positive_cancel_step.py:177`
required 3 gib free; actual free space was 3,122,749,440 bytes. subsequent
read-only checks saw 1,945,808,896 and 1,128,189,952 bytes. available memory was
over 4.5 gib. the exact global-after container does not exist; cancellation
itself succeeded. no final equality or fresh migration proof is claimed.

private evidence: campaign
`b-reader/article-index-positive-cancel-v1/step2-headroom-reconciliation-v1/`
and `root-steps/02-global-after/`. docker reported 50.4 gb in volumes and
18.3 gb in images; these totals do not establish ownership or deletability.
the canonical backend build for main was still queued.

identify capacity by owner. retire only reconciled task-owned disposable
resources, preserving the verified backup, actual receipts and active reader
clone until its interval closes. do not prune shared images/volumes, lower the
reserve merely to get a passing invocation, or resize/reboot the host.

acceptance: sufficient stable capacity for the existing envelope; the failed
pre-create attempt remains recorded, the exact final comparison completes,
and later restores/migration runs fit the available capacity. qualify lane
clones sequentially if retaining several copies is the cause.
