# ordinary-read repair release

implementation and qualification are in progress; production still serves
`d05d69bd18afceb588ae7f74598043dd3068b3e5`, schema `0346`, wire `24`.

before cutover:

- qualify evidence identity and the fixed isolated diagnostic; preserve exact
  valid authority, reader left joins, ranking and freshness.
- audit all stored citation evidence for the canonical external-reference rule.
  the initial read-only audit found 753 evidence snapshots, nine canonical
  external owners and no malformed owners or removed matches; repeat if writes
  make that audit stale. affected data needs explicit source-owner disposition.
- use the existing paired release with exact source/image identities, unchanged
  schema/wire and resource limits. never import application diagnostics inside
  the serving api or restart the retained old vps.

after cutover, qualify one bounded production diagnostic and ordinary concurrent
browser reads; report main/support observations and any remaining refusals.
remove temporary drivers and owned fixtures/profiles after final qualification.
record unobserved installed-device behavior explicitly; do not infer it from
browser proof or change installed clients for this backend repair.

resolved when the real read regression, exact authority and isolated diagnostic
completion/failure cleanup are qualified, release identity is verified and
owned verification resources are gone. latency guidance is soft; no percentile
or unrestricted capacity claim follows from a few ordinary observations.
