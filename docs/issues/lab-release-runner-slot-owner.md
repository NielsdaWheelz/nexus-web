# release slot owner is archived

problem: `lab-host-budget` §4 and macbook-capacity d2 require the macos
release lane to share the host slots and complete beside a lab run at 8 gib
and 8 cpus. the named `bootstrap-release-macbook` branch is absent from
origin; its runner exists only at the archived tag
`archive/2026-09-14/bootstrap-release-macbook` (tip `e7fd4b88b`).
`scripts/release-bootstrap-macos.sh` is absent from current main `57988f8b5`.
that script publishes android-v0.2.14 and invokes the retired pre-reset suite.

impact: there is no current entrypoint to update or run for that acceptance
criterion. restoring the archived lane would revive retired infrastructure.

blocked on the owner identifying the current release entrypoint, or explicitly
revising the criterion. resolved by that explicit revision, or when the chosen
lane uses the host slots and its required concurrent run passes at the
operator-configured docker budget.
