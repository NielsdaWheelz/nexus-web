# metadata research exhausts interactive-worker memory

production source `191ae4461`, schema `0335`, 2026-11-05: at 19:04:27 utc the
kernel killed the interactive worker's python process, host pid `2993198`,
with anonymous rss `284384 kb`. its `320 mib` container limit remained in
force and docker recorded a restart. this is separate from the
[postgres incidents](production-search-postgres-oom.md).

the active metadata job was `01a1acfd-07ce-7196-a19b-e6cc8dc7334a`, “letters
of john keats to fanny brawne”. at 19:13:36 it remained at attempt 1 with an
expired 19:04:55 lease. it succeeded on attempt 2 at 19:18:32; the 19:47 batch
census found no unfinished jobs. recovery is established for this interruption.

memory exhaustion is established; the responsible allocation and possible
accumulation across prior jobs are not. inspect the affected generation/tool
boundary and attribute demand before changing limits. resolve when representative
research completes within the declared worker and host budgets without oom.
automatic restart alone does not establish capacity. broader recovery remains
with [the job recovery issue](release-metadata-update.md).
