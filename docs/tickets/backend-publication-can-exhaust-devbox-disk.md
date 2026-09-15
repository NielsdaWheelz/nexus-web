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
