# activate concurrent lab admission

qualification passed; cross-repository integration and activation pending. baseline
`aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306` takes only two slots, including for
exclusive runs (`python/scripts/disposable_runtime.py:619-635`). mixed old/new
runners therefore cannot preserve measurement exclusivity.

before the first changed-runner invocation, including qualification: finish
old-runner red cases, drain old invocations and waiters, and verify their owned
runtimes are gone or recover them explicitly. update participating worktrees to the new
harness and use one common host state directory/capacity setting. preserve the
docker cpu, memory and disk limits, unrelated resources and reusable images.
never remove live slot files or infer process ownership from a saved pid.

update nexus verification docs and dev-server's `docs/macbook-capacity-plan.md`
two-slot policy together. changing capacity later also requires drained labs and
waiters; there is no live resizing or backward-compatible admission protocol.

resolved when six-run acceptance and scoped teardown pass on the fixed allocation,
all participating runners use the new contract, and both repositories' policy
changes are integrated. fewer concurrent labs is an unresolved capacity blocker.
