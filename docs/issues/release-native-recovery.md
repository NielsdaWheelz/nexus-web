# release: native execution recovery

problem: the [native recovery contract](../modules/llms.md) changes
host transport, generation control metadata and dependency pins together. mixed
versions cannot establish incarnation identity or safe retirement.

impact: release requires coordinated downtime; neither a fixed native socket nor
an old boolean `settled` record is a compatibility path.

required order:

- after the librarian base merges, retarget the stacked recovery review to `main`
  and require hosted ci; its workflow runs only for that base branch.
- qualify pinned provider/host protocol and actual owned-container retirement;
  ordinary shared live labs never receive retirement authority.
- provision/enroll the exclusive qualification account volume through existing
  custody tooling if absent. no production/shared credential copying. the owned
  lab mode retains enrollment and removes only its runtime resources.
- stop new admissions, then drain/reconcile outstanding work with the existing
  release controller. stop remaining workers/native host, prove predecessor
  container teardown and verify a backup. require zero open old bindings; unresolved
  old bindings require reviewed live repair before migration; no guessed epoch.
- rehearse the one migration after head against the newest backup. preserve old
  terminal binding metadata; atomically reject open/unconvertible rows.
- initialize private host state explicitly; ship matching host, provider pin,
  control/native address configuration and nexus consumers. keep one container
  owning each state volume. never recreate lost state silently.
  with the old host stopped and the new image selected, run the host service's
  one-off `python -m apps.codex_agent.state` before first startup; it initializes
  only a missing state file and refuses replacement. do not re-enroll or copy
  existing credentials merely to initialize identity.
- verify exact schema, old-receipt observation, fresh native admission, foreground
  send/cancel/recovery and editorial retention before declaring release qualified.
- update shared lab configuration only after its existing owner drains attachments;
  preserve enrollment custody. qualify destructive recovery on an exclusively
  owned host through the normal lab owner.

recovery uses the existing stopped-writer release procedure and verified backup;
no backward reader or overlapping host replacement. database restoration must
never rewind private host state/counters or reuse an incarnation. host-state loss requires
proof of old host teardown and deliberate operator repair, not a manufactured
retirement receipt.

resolved when the paired release and listed runtime observations are complete.
source implementation and isolated qualification are complete on
`feat/native-recovery`, with provider `adf5a5a4` and kernel `e5c46d39`.
production has not been changed; the coordinated cutover and release observations
above remain outstanding. the shared lab host also requires its owner-led upgrade.
