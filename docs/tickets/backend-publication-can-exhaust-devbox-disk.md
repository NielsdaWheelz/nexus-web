# backend publication can exhaust devbox disk

status: open · origin: 2026-09-15 restoration publication · area: backend publisher · oi-126

## evidence

publication of `736cb651bfa2539162faf8b26c642ae09a3c1520`, run
[35017770963](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35017770963),
built and pushed both images, then failed during bundle construction at
20:11:22 utc. the runner reported `System.IO.IOException: No space left on
device` while writing its diagnostic log. no immutable bundle was uploaded;
that sha was never deployed. production remained at6baccaee, db0229.

retained restoration diagnostic images and temporary build layers shared the
root filesystem. available space fell from1.5 gib during the build to48 mib.
the runner died before its `always()` cleanup steps, leaving its exact buildx
builder and state volume. operational cleanup removes only that builder and
inspected task-owned diagnostics/images; database/object volumes, archives
and primary worktrees remain intact.

## next action and acceptance

establish the publisher's scratch-space requirement and reject insufficient
space before building. keep this at the publication owner; do not add another
test gate or broad automatic cleanup. prove an insufficient-space refusal
precedes image creation, and that a normal publication still produces one
immutable exact-sha bundle. the current operator cleanup does not resolve
this missing admission check.

## operational recovery

exact failed-builder and retained task-diagnostic cleanup restored11.3 gb free
disk. fresh5acb211a publication35018779862 completed, including bundle upload
and cleanup. no backup/database/object volumes or primary worktrees were
removed. this successful retry with a fresh sha does not close disk admission.

## recurrence: 2026-10-15

first-attempt publication of `597e94892389b655be9d96133b2e178be32b9cef`,
[run 38806298863](https://github.com/NielsdaWheelz/nexus-web/actions/runs/38806298863),
job `116667936172`, failed at 21:01:53 utc after both image pushes and private
deploy-key removal, during candidate manifest creation. the runner reported
`System.IO.IOException: No space left on device` for
`/home/niels/actions-runner/_diag/Worker_20261015-205902-utc.log`.
no accepted candidate manifest exists; production remains on `83459f1b8` at
schema `0287`. the failed run must not be retried or its pushed images deployed
without the required provenance.

dev-server's root filesystem had 565,628 kib available and reported 100% use;
the runner recovered to online/idle. scoped storage inspection and publisher
admission correction are pending. preserve all task databases, volumes, source
archives and worktrees. this is separate from the earlier mac docker outage
and from the completed production image-cache cleanup.

source correction under qualification: publication now requires 8 gib free at
the docker root and runner temp directory before creating its builder or
writing the deploy key. it removes only that build's builder/cache before
pulling runtime images; summary/history export is disabled. the actual
low-space devbox refused at 582,713,344 free bytes, leaving every container,
image and volume identity unchanged. receipt: book-repair campaign
`coordinator/final597e9/backend-build-failure/disk-admission-low/receipt.json`,
sha256 `c040daced8113609caa3bfe89dd69f2a2a7fa9c3c48b01965eff5afd9c8feb83`.
the recovered-capacity admission and first-attempt successor publication are
still required before this ticket is resolved.
