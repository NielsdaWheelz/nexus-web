# release empty resource cleanup

problem: weekly empty-resource cleanup requires release qualification and
existing-data cleanup. the source contract is in `docs/modules/notes.md`.
production has not been changed by this implementation.

required before activation:

- qualify the exact authored tree with temporary real-stack red/green/refactor
  probes, independent review and `./scripts/test`; remove temporary probes only
  after retaining concise private/pr proof.
- migration `0298` initializes existing activity clocks at cutover without
  changing bodies, titles or collection ordering. this hard cutover rides wire
  revision 12: the latest released
  `android-v0.3.4` uses 11 and main already moved to 12 before this change. qualify
  the paired web/android build without another pre-release revision bump.
- use the existing deployment/backup controller. take a fresh verified backup
  with a new archive/state identity and rehearse the exact operator on its restore.

the raw `0292` production backup requires reviewed x source-evidence repair
before `0293`. the [x cutover owner](release-x-thread-imports.md) records that
repair and a completed LOCAL x migration/reader rehearsal; production is unchanged.
the [insertion release record](release-resource-insertion.md) and this release
still require the actual combined-head rehearsal on the newest verified backup
with deliberately reviewed repairs. isolated `0297`→`0298` fixture conversion
does not satisfy that release check.

index/discovery jobs are not retaining facts. canonical teardown clears the
resource's graph, anchors, index and protocol state; queued/running jobs may
finish afterward by observing absence. terminal job history belongs to existing
background pruning, rather than immediate per-resource job deletion.

initial repair uses the same seven-day inactivity rule. an immediate preview
after cutover will legitimately contain no historical candidates. once that
cohort is eligible, inspect the content-free inventory and its cascade counts.
for reviewed cli apply, stop actual writers, recompute and validate the complete
reviewed inventory before effects, then use canonical teardown. abort on database,
schema, implementation or candidate drift. verify deleted ids, protected rows,
normal job scheduling and second-apply no-op independently.

resolved only after the first eligible weekly run or reviewed apply demonstrates
existing-data cleanup and protected-row preservation on the deployed source.
deploying the feature, passing static checks or producing an empty early preview
does not close this issue. installed-device and deployed-source repair remain
`NOT_RUN`; local fixture proof cannot substitute for either.
