status: open
origin: 2026-09-11 reader document map session
area: test infrastructure / host release harness

`test-results/runs/66b467c42ff079ba/kernel-python-1.log` fails before release
behavior in `test_first_0224_apply_accepts_the_exact_0216_predecessor_shape`.
`python/tests/testkit/host_release.py:275` runs noninteractive sudo to chown the
owned parser temporary directory to uid/gid 10001 and chmod it 0700. the
subprocess exits 1; captured stderr is not included in the failure. 78 earlier
kernel checks passed. this does not exercise migration 0228.

prerequisite: inspect the permitted privilege boundary for the local release
harness. restore the required ownership operation through its setup owner and
surface its captured error if it fails. preserve production ownership checks;
do not relax them to make the fixture pass.

acceptance: the existing release proof passes through `./scripts/test` using the
approved local setup, and ownership failures report an actionable cause.
