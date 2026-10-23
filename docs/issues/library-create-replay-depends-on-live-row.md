# library creation replay depends on a mutable live row

status: open; ordinary empty creation only. refreshed 2026-10-22.

problem: ordinary empty creation carries `initial_items:[]` and a null removal
fence. after row deletion, resending that id can recreate the empty library.
client ids deduplicate only while their live row survives; no replay ledger exists.

evidence: `python/nexus/services/libraries.py:165-184` returns a present row but
inserts when absent. `schemas/library.py:CreateLibraryRequest` requires a null
fence for empty creation. source-derived; empty replay not reproduced live.

create-and-file now carries a frozen acquisition fence: library deletion,
including accepted absent deletion, advances it in the same viewer-locked
transaction. old create-and-file conflicts rather than restoring filing, including
after accepted absent deletion. that guarded path is live-qualified in this cutover.

reproduce: freeze `{id,name,initial_items:[],expected_removal_revision:null}`;
create, delete, then resend. the empty library can return, with no acquired
content or named placement replayed.

resolve with an explicit authored-create identity lifetime policy. general
create/delete ordering is outside this cutover; do not introduce a hidden ledger.
resolved when delayed empty creation cannot reverse accepted deletion within
the supported replay lifetime. surviving-id repeats must keep returning the
current library without reapplying initial contents.
