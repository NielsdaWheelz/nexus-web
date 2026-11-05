# source success is invisible to followups

`source_runner._settle` marks an orm source attempt succeeded, then admits followup
metadata with autoflush disabled. `x_source._load_sources` queries persisted successful
attempts and raises `published post requires a finished source attempt`; the complete
source publication rolls back.

observed in the real x publication path in
`/tmp/nexus-metadata-recovery-verification/metadata-frozen-constraints-green.log`.
flush source success before dependent sql reads, within the same publication transaction.
resolved when real x source publication admits metadata for that exact finished attempt
and the frozen-source supersession checks pass.
