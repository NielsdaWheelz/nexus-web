status: open
origin: 2026-09-12 reader pr #238, ci `34718249742`
area: ci dependency cache

the post-setup annotation reads `Restore cache failed: Dependencies file is not
found` and names supported pattern `go.mod`. the repository has no tracked
`go.mod` or `go.sum`; `.github/actions/setup-test/action.yml:21–24` enables go
setup without declaring cache ownership. setup succeeded; this warning did not
cause the job timeout.

prerequisite: identify the go tool installation and intended cache owner.
configure module caching only for a real owned module, or explicitly disable
that cache for tool-only setup.

acceptance: go-backed tooling remains available in canonical ci and post-setup
completes without a missing dependency-file cache warning.
