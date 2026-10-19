# canonical backup rerun lacks attempt reconciliation

status: deferred to deployment-tool reauthoring
origin: 2026-10-16 backup-key source review at `52cf34bc06f239951bd5ca9219d8b10b3f6c9fb9`
area: release / backup attempt ownership

`deploy/hetzner/release.py:406` starts the backup at line 438 with
`compose run --rm`, without an explicit attempt name, captured container id or
retained terminal receipt. its writer-stop checks exclude one-off containers
(`release.py:656–663`). `deploy/hetzner/deploy.sh:2–3` advertises rerun, but the
wrapper and controller have no active-attempt exclusion or backup reconciliation.

`python/nexus/release_backup.py:132–138` assumes a deterministic host-owned
container excludes overlap before aborting exact-key unfinished multipart
uploads. after lost ssh before a durable dump receipt, a blind canonical rerun
has not established that the earlier attempt stopped. if it remains active,
the new invocation can abort its upload and start another dump. this is a
source-level gap; no production overlap or corruption was observed.

address the attempt boundary in the deferred
deployment-tool rewrite ([queue 16](../reauthoring.md#queue)), using the existing
backup owner. preserve the exact attempt identity and terminal evidence, and
reconcile an interrupted attempt before allowing another dump or multipart
cleanup. the current maintenance v3 path has its own named
create/persist/start/terminal boundary and stays outside this change.

acceptance: in an isolated backup, lose the controller connection after upload
starts and before its durable receipt. a successor must refuse while the prior
attempt is active, or reconcile and retain its terminal result before proceeding.
prove no duplicate active dump or abort of an active upload; retain the original
attempt identity, terminal evidence and resulting archive/receipt disposition.
