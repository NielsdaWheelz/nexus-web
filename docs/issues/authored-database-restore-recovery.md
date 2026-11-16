# authored clients need an explicit database-disaster recovery procedure

an older server backup can lose commands already acknowledged to authored clients.
ordinary catch-up does not establish a recovery procedure for that rewind.

source evidence at `839bb918b4573fa42fb96eb9a9d0fb798b5704b7`:
`apps/web/src/lib/authored/persistence.ts:229-233` deletes acknowledged command
bytes from `pending_changes`; `python/nexus/services/authored/__init__.py:244-245`
rejects source sequence gaps, and lines 797-798 reject a cursor above the restored
account head. local projections may survive while the ordinary outbox no longer
contains the acknowledged history needed to advance the restored server.

define disaster recovery at the authored owner: preserve each device's local
writing, identify the lost server interval, and specify any required reconciliation
or replica re-enrollment before resuming ordinary synchronization. do not clear
local stores or reset cursors as a generic repair. retained local projections are
not proof that every lost server command can be reconstructed.

resolve with a bounded recovery rehearsal covering acknowledged commands after
the backup, additional unsent local commands, an offline second client, and normal
writing/catch-up afterward. document any unrecoverable data explicitly. no disaster
restore was run in this assessment. a planned host migration must instead copy
the final quiesced database without rewinding its accepted heads.
