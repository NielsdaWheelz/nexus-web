status: open
origin: 2026-09-14 bounded reader whole-web validation
area: release test host filesystem boundary

run `8253d078e933c1cc` passed all three static-web commands, then stopped before
browser checks at `test_first_0224_apply_accepts_the_exact_0216_predecessor_shape`.
`python/tests/testkit/host_release.py:275` failed its existing external operation:
`sudo --non-interactive sh -c 'chown 10001:10001 "$1" && chmod "$2" "$1"'`
for the test-owned `var/lib/nexus/parser-tmp` directory. subprocess exit was 1;
78 preceding release/kernel cases passed. the captured log provides no further
stderr, so that run did not establish the cause.

diagnostic replay `18e0273da1d53ae1` preserves subprocess stderr and reports:
`sudo: The "no new privileges" flag is set, which prevents sudo from running as root.`
the calling shell also has `NoNewPrivs: 1`. this is a host execution restriction,
not a failed release ownership policy. the exact real-ownership proof needs the
supported protected runner; do not weaken the fixture or bypass the restriction.

inspect the exact host harness stderr and permissions under the public controller;
repair its supported test boundary without changing release ownership policy.

acceptance: the exact predecessor-shape case and its selected release kernel
portfolio pass through `./scripts/test`; retain the real ownership operation.
