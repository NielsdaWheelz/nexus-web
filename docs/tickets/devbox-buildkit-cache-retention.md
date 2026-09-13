# devbox buildkit cache retention

status: open
origin: 2026-09-13, pr #243 release session
area: test control / backend release-artifact capacity

## issue

repeated candidate-image proofs in the bounded-workspace checkout grew the
shared buildkit cache from 606.9 mb to 10.04 gb. root free space fell from 18 gb
to 8.2 gb. four api/worker image builds were retained while the checkout was at
`7fa89b`. `docker builder prune --force` reclaimed 9.436 gb, proving the retained
builder cache owned the growth. that operator-wide prune could also remove cache
belonging to another checkout, so it is diagnosis, not an acceptable fix.

## prerequisites and fix

coordinate with the backend candidate-image proof now under development in the
bounded-workspace lane. give each proof run a uniquely named docker-container
builder and remove that builder in a `finally` path after success, failure, or
interruption. retain the existing exact image cleanup. admit this capability
only when free storage covers its measured maximum transient footprint plus the
8 gb operator reserve; do not raise the floor for unrelated heavy proofs.

## acceptance

- success, injected build failure, and interruption all remove only the owned
  builder and cache;
- repeated exact candidate-image proofs leave no builder or cache growth;
- foreign builders and caches remain untouched;
- the affected proofs pass through `./scripts/test`.
