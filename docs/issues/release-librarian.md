# release: librarian hard cut

the [implementation](../librarian-spec.md) is qualified locally; release still
requires the coordinated installed-device preconditions below. read-only preflight on
2026-11-11 observed schema 0337 (release 422dc25968fd988580542d9e193b64d1731e19cc),
three accounts, eight chats and one branch. the verified 2026-11-11 backup passed
the local cutover rehearsal, including account isolation, preserved history and
authored causality, and the eight explicitly approved dangling-record removals.
no production mutation has run. installed device state remains unverified.

required preconditions:

- inventory installed server/schema, web/android authored formats and every
  provisioned replica. [release-daily-work](release-daily-work.md) records an
  undeployed format change; confirm the actual upgrade chain, never assume it.
- prove every participating device has no uncommitted input, an empty outbox and
  its cursor at the frozen account head. server acknowledgements alone cannot
  prove a remote outbox empty. preserve device identities and source counters.
- settle chat/selection jobs, stop writers through the existing release owner,
  verify a backup, and rehearse the sole migration against the newest backup.
- account recent-navigation caches reset from format 1 to 2 on first open; up to
  100 shortcuts are discarded. this does not affect workspace visits or writing.
- ship the paired server/web/android authored-format transition: canonical
  reference conversion, old-feed floor, and empty-outbox snapshot reprovisioning.
  reject old clients; resume writes only after each complete verified snapshot.
- verify migrated message links, local authored links/embeds, first new authored
  write, fifo send/cancel/retry, brief save and first editorial publication.

recovery uses the verified backup and matching binaries/clients; no backward
reader or in-place partial rollback. independently record hosted static checks,
backup rehearsal, live provider behavior and installed-device acceptance.

resolved when the coordinated release and listed journeys are observed, or when
the owner explicitly cancels this release. evidence belongs in its implementation
pr; keep only unresolved conditions here.
