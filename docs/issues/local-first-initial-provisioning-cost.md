# full corpus provisioning is slow

full replication has a substantial first-use cost. qualified source `1ed35d40b`
in `20261027-203800-d4ed7d80a966` reports firefox sign-in to usable writing at
250,744 ms and the samsung handoff to observed usable writing at an upper bound
of 498,901 ms for 100,000 notes with eight prior edits. the private run's
`firefox-capacity/results.json` and `native-capacity-results.json` retain those
measurements and boundaries.

initial provisioning is explicitly reported separately from cold-open latency;
it is not a failed cold-start budget. cold, warm, search and typing budgets,
final accepted prefixes and exact canonical append assertions all pass. the
remaining concern is waiting several minutes before the first complete local
corpus is usable.

any future improvement must preserve complete-corpus readiness, resumable
provisioning, atomic publication, the same corpus/history and independent cold
clock. resolve after agreeing a first-provisioning target and qualifying that
target through the real paired flow; do not silently relabel partial readiness
or raise an unrelated deadline.
