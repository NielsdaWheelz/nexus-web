# backend publication binds recovery to a new source commit

status: open · area: release / publication provenance

an infrastructure failure consumes the only publishable attempt for that
workflow run. `.github/workflows/backend-images.yml:16–18` skips reruns, and
`deploy/hetzner/release.py:242–259` checks the run's current `run_attempt == 1`.
`deployment.md:35–38` consequently requires a new commit after a failed build.
the disk admission failure at `backend-images.yml:66` exposes this recovery
cost. rerunning an already successful run also makes its
existing artifact fail the resolver's current-attempt check.

the source-change requirement is inconsistent with the accepted triggers:
`backend-images.yml:3–5` and `release.py:244–246` also allow a new `release/`
branch push at the same sha. changing runner ownership leaves this policy intact.

fix the publisher and resolver together: bind provenance to the exact successful
run and attempt, preserve the accepted immutable manifest, and define one
unambiguous publication for each source sha. do not merely remove the attempt
guard or use release branches to evade the documented recovery rule.

resolved when a failed build can recover at the same source sha, later attempts
cannot invalidate an accepted candidate, and repeated publication cannot create
ambiguous deployable artifacts. prove exact source, digest and attempt identity
through the existing release resolver.
