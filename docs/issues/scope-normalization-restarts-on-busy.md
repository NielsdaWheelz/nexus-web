# installed busy-retry correction closeout

on 37d, `Sync.run` cleared the normalizer after every `scopeStep` failure. a
pre-work busy status read could consequently delete incomplete normalized chunks
and restart a large interval. repeated refusals could prevent completion; raw
text, completed intervals and authored writing remained intact. the personal
clients' exact cursor history was not observed, so their busy status alone did
not establish this loop.

pr880 changes only the exception boundary in `apps/web/src/lib/authored/sync.ts`:
retain valid state across failed observations, detach before mutation and restore
only after corresponding writes commit. revision/revocation/structural changes
and failed persistence still discard it. the actual Sync/sqlite case reproduced
old failure and passed retained partial progress, failed-write recomputation and
unchanged completion/fences on the repair. no format, timer or cap changed.

e505 is deployed and its matching 4a3469 apk is installed and byte-verified.
close this defect after useful continued preparation is observed on the paired
installed clients. [complete personal scope](authored-scope-hydration-repeats-revision-work.md)
remains a separate final outcome; do not require a second component campaign.
