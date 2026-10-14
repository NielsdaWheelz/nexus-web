# qualify rollback of the later deployment-tool rewrite

status: open; owned by the separate post-release tooling rewrite
origin: 2026-10-13 release; review of the proposed "previous deploy.sh at the old sha" rollback
area: release tooling / recovery

an old script or checkout alone does not satisfy the current deployment contract.
at `3ea1b8e6e`, `deploy/hetzner/deploy.sh` requires the requested source sha to
equal both checked-out head and `origin/main`; `release.py:309` repeats that
check and resolves the immutable candidate for that sha. copying an old script
into the current checkout also violates the clean-checkout guard.

the later rewrite needs an executable, rehearsed rollback procedure that keeps
those source/image/config bindings intact. a revert commit with its own first-push
candidate is the straightforward route; any separately chosen operator-code
boundary must be explicit and qualified before merge. do not weaken provenance
checks or present an old script alone as a demonstrated recovery path.

acceptance: rehearse recovery from a failed new deployment-tool run on the
devbox, recording the exact commands, candidate identity, database revision,
backup preservation and final health/promotion result.
