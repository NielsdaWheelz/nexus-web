# a late run read can restore deleted messages locally

status: open
origin: 2026-10-16 chat viewer adversarial specification review
area: chat / canonical graph membership

`apps/web/src/components/chat/conversationStore.ts:100-125` at `69c00182c`
merges each incoming run pair into the message map. its updated-at guard only
protects ids already present. `readRun`, cancel or adoption may finish after
a deletion's full tree read removed those ids, then add the deleted pair again.
the same merge remains at `origin/main` `ff5712884`; its citation-deletion
filter does not protect message membership. source-proven race, not reproduced
in production.

impact: the visible graph can disagree with the saved graph after deletion.

fix: full canonical tree snapshots own membership and selected leaf; run reads
update only still-present ids. newer graph revisions require a tree refresh;
older reads cannot add members or regress the graph revision. preserve current
per-message timestamp protection and citation-deletion guards.

acceptance: delay a real run response, delete its subtree and settle the new
tree, then deliver the old response. no deleted message, fork or citation returns;
the pane and reload agree. retain legitimate pending-to-complete updates.
