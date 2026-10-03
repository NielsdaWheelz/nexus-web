# model reset deletes background undo evidence

status: open; release blocker
origin: 2026-10-02 kernel historical-uncertainty verdict
area: migration 0246 / generation effects

evidence: `0246_latest_model_history_cutover.py:121–171` copies authorship
identities, then lines 385–401 delete original model turns, tool positions and
generation parents. baseline `python/nexus/services/agent_api.py:358–390,416–427`
lists/undoes through the original position, credential and parent. native
candidate `a3540e3dcbb79a0235ef21fba67fb5c6966bcfbd`,
`python/nexus/services/generation_effects.py:20–61`, requires the original live
position joined to its parent, ownership and result/created-ref evidence;
otherwise undo returns 404. copied authorship alone cannot preserve that contract.
the valid `0252` → `0254` → `0255` fixture begins after this reset and proves no
`0241` → `0246` effect preservation.

fix owner: nexus reset/ledger and domain-effect owners. make the approved reset
preserve the original evidence required by its durable effect/undo contract.
use the existing owners; preserve original identity, ownership, results,
uncertainty and reverted state. do not fabricate replacement terminals or treat
missing evidence as successful undo. fresh exact census and a verified
pre-disposition archive are prerequisites.

acceptance: restore the actual starting-revision backup and execute the reviewed
disposition plus exact migration chain. original effects remain inspectable;
real owner undo succeeds once and repeats safely. stale replay remains fenced,
unreviewed work aborts atomically, and no provider call occurs. requirements only;
fresh census, disposition, restore and this proof are NOT_RUN.
