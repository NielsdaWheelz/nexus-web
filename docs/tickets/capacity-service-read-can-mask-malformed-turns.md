# service-health failure can mask malformed passed-turn evidence

status: open · origin: 2026-09-15, restoration release review · area: capacity qualification

`deploy/hetzner/release.py`, `qualify_codex_capacity`: a canary reporting
`passed` has its turn contents validated after incumbent service health.
a simultaneous service-health read failure returns a retryable refusal before
those contents are validated. qualification still fails, but a malformed
candidate statement may escape the intended permanent classification.

this ordering predates the observed-memory change. complete failed terminals,
schema/exit mismatches and sampled cgroup breaches now take precedence over
transient host refusal. no observed production run triggered this corner.

when changing this boundary, validate the canary turn contract before service
observations through one shared decoder. prove malformed turns remain a
candidate failure when the service read also fails, using a cheap deterministic
case. do not add a release simulation suite.
