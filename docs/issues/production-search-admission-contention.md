# production search admission contention

production source `3d81ef45` passed the machine, catalog, canonical reader and
committed autosave checks, but the initial physical-phone keyword and related
searches returned 504 before retrieval. keyword waited about 1.495 s for
admission at 18:26:04–06 utc on 2026-10-25; related finished its provider call,
then waited about 3.682 s at 18:26:06–09. neither acquired the expensive-read gate.

at 18:26:59.792485 utc a background `suggestion_shortlist_refresh` failed with
postgres 57014 / `QueryCanceled`; its stack includes `_similar`, `_candidates`
and `rank_suggestion_refs`. `suggestion_shortlists.py:220` holds `search_session`
through that ranking and materialization. this is a possible holder, not a
historically identified blocker: retained logs contain no backend-pid or
admission-span join. an exact-key lock snapshot at 18:39 was empty. it cannot
explain the earlier interval. these observations do not establish cpu demand,
a leaked lock, or retrieval latency.

private evidence: `phone-workspace-search-api-summary.private.json` and
`phone-admission-worker-background-window.private.log` (`00f97cc9`), plus
`phone-current-admission-holder.private.json` (`8c294a99`), under the rollout
checkout's `.nexus-local/rollout/`.

the one subsequent request-correlated phone operation at 18:46:13–14 utc
completed: keyword 200 in 865.55 ms and related 200 in 1211.70 ms. the bounded
observer took 61 snapshots and sampled only api holders. related briefly waited
behind the keyword api backend, then acquired admission after 92.30 ms. the
phone displayed results without an error. this proves that operation completed
under the accepted deadlines; it neither proves a warm percentile nor identifies
the historical 18:26 holder. retained final summaries are
`phone-final-query-api-summary.private.json` (`08dc9664`) and
`phone-final-query-observer-summary.private.json`, with raw observer `c5b396ab`.

keep the initial failure and worker cancellation unattributed. this rollout
retains serialized admission and its accepted budgets; no ranking, memory or
scheduling change follows from this evidence. if contention recurs, capture the
exact-key waiter/holder pid and container while it exists, and account for that
caller's admitted lifetime before choosing a repair. this record is resolved
when the cause is established and corrected or explicitly accepted with its
observed limits; the later successful operation alone does not establish that.

2026-10-26 live attribution: at18:18:34.571utc, granted holder87963 on the exact
`nexus:expensive-search` advisory key was the background container172.18.0.3.
its suggestion-similarity query had run121.20s since18:16:33.366. postgres
cancelled it at18:21:33.328 on the worker's300000ms statement timeout; refresh
job01a1796d-9a8c-7e7b-8a97-b8528ae81d29 settled failed at18:21:34.118. another
background similarity query held the gate at18:23:11.157. these observations
identify current ownership, not the historical2026-10-25 holder. no browser
waiter was present in these snapshots; browser1.5/5s budgets cannot accommodate
the observed sustained hold.

the complete captured SQL/parameters were replayed read-only on the verified
0317 morning backup using exact deployed images under amd64 emulation. all five
original anchors and1114 eligible media validated. one original anchor took
5.18s and returned zero candidates; five anchors exceeded a15s diagnostic cap.
the one-anchor plan performed550881 embedding lookups,708753 shared-buffer
reads and10978 temporary blocks each read/written. anchor selection and peer
readiness each hashed722253 chunks from a3394-row estimate, growing to8 batches.
ready-state rows were estimated3 versus579 observed. final ranking received
zero rows and was not the spilling owner.

next controlled candidate: use the existing0317 expression statistic by making
the six positive readiness comparisons `(alias.lexical_revision = alias.revision)
IS TRUE`, as `search/semantic.py` already does. this preserves positive-filter
semantics but has NOT been tested in this suggestion statement. compare outputs
and plans before any structural rewrite. per-anchor splitting alone has not
established interactive lock occupancy; exact peer slices or a reviewed bounded
retrieval contract may still be required. a lower timeout that repeatedly aborts
the whole computation does not prove useful background progress.

private evidence is in `nexus-search-profile-20261026-bzr4ivr6`. emulation,
rebuilt indexes/statistics and snapshot age preclude a production latency or
capacity claim. production and application code remain unchanged.
