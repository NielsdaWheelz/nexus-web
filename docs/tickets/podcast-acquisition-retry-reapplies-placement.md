# podcast acquisition retries can reapply later-removed placements

status: open · origin: 2026-10-14 library chooser specification · area: podcast acquisition / replay

problem: acquisition retains a logical retry identity in the ui, but podcast subscription and episode acquisition do not carry it to a replay boundary. a late retry can re-file an item after a later removal.

evidence: `apps/web/src/components/browse/AcquisitionControl.tsx:3-7,30-36,179-201,240-245` freezes an idempotency key. `apps/web/src/lib/podcasts/api.ts:85-116` omits it; `python/nexus/api/routes/podcasts.py:32-43` accepts no key. `python/nexus/services/podcasts/subscriptions.py:169-175` and `episode_acquisition.py:70-72` apply placements on each execution. source-derived; no live reproduction yet.

reproduce: commit an acquisition with a named destination but lose its reply; remove that placement through the public api; replay the frozen acquisition. the old operation can add it again.

prerequisites: retain acquisition's transaction-composed placement and replacement-confirmation semantics. this is outside the library chooser's direct-placement command contract.

fix: pass the acquisition identity through each podcast adapter and own durable exact replay in the acquisition service before provider/mutation work. do not split acquisition into browser-side placement commands.

acceptance: same key/body returns the original outcome without re-subscribing or re-filing; changed body with the same key conflicts; fresh keys intentionally apply their own work. delayed acquisition replay cannot undo a later placement removal.
