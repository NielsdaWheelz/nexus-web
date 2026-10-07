# connections verification

2026-10-07 · branch `feat/connections-cutover` · baseline `a494f743e` · head `0253`.
implementation and proofs refer to this pinned baseline. current-main integration
and production release remain separate prerequisites; this is not a deployed receipt.

three coding owners, independent contract/content reviews and root integration
review covered graph/chat, admission/notes, web/discovery, and migration. temporary
drivers used real authenticated api/database/browser and existing domain owners.
meaningful reds included stance/self/passage admission, asymmetric context,
missing transcript reads, picker/connection pagination, hidden reader links,
annotation identity, stale generated chat contracts, suppression publication and
refresh/continuation/removal/retry focus races. affected proofs passed after fixes.

| contract | observed |
| --- | --- |
| linking/admission | all 17 eligible families in both endpoint roles; five passage aliases share durable-link identity; search writes nothing; missing/inaccessible/stale/self inputs rejected atomically; reverse/concurrent/exact retry yields one pair; existing pair behind 100+ rows hydrates by id |
| interaction | normal menu/pane/fragment/pdf entry points share the composer; search continuation and 106+ connections reachable; lost committed response retains exact retry across close and another intent; upload once, close while pending, retry saved media, undo preserves media/highlight |
| reader/annotations | real pdf upload/ingest/text-layer quads; distinct user link within passage group; first note save response lost then byte-identical replay; separately typed successor saves to the same note with higher version; reopen hydrates actual body; real extracted source note expands/collapses; follow/all-items, offscreen jump, source navigation and return preserve position within one line |
| provenance | assistant/discovery/citation/attachment identities retained; annotation note exposes both attachment facts; actual chat/background undo; verified chat receipt, generation effect on page two and unavailable retained creation path; no guessed delete/navigation |
| refresh/focus | failed refresh retains 107 rows and exact focused node; retry leaves 106; late continuation cancelled; removed row and failed-removal retry restore owned focus; deliberate independent focus movement respected |
| writing | shared diamond/cycle expansion, path terminals, shared edits and independent endpoint order; mixed paste clones notes/reuses resources; literal brackets, ordinary urls and whole-block embeds survive; old journal retained/exported byte-for-byte without dispatch |
| chat | both orientations and chat–chat; shared membership for prompt/frozen read/search; no recursive attachments; citation context survives unlink and can detach without erasing occurrence; earliest rank survives removal; independent chat ranks |
| reading | all completed branches, roles/parents and unicode oversized content reconstructed across bounded pages; stale/malformed/foreign cursors rejected; unfinished/unrelated content excluded; passage quotes readable |
| durability | actual embedding/index replacement removes old chunk while anchor/link survive and deduplicate; actual artifact build/compile/publication replaces revision while head/link survive. artifact input was a compiled fixture, not model output |
| migration | real `0252` clone → `0253`: 14 preservation assertions plus unequal ranks/saved-state merge, version/replay reset and old body/inverse rejection; conflict, forbidden target, unfinished ledger/queued chat guards roll back all ddl/data; terminal/unchanged grants pass without receipt rewriting |
| vocabulary/ranking | retired active routes/imports absent; fixed 18-candidate inputs preserve lectern/quick/library ordering and eligibility; raw real historical receipt stays inspectable and cannot enter active decoding/dispatch |

genuine discovery used the ordinary scan route and exact-job worker with the
enrolled `CodexPersonal` host, native `0.157.1`, `gpt-6-luna`, low reasoning.
jobs `ba68d0ea-0481-4f64-8ecc-52c7cc69da60` and
`6b9d9d59-16e9-4d44-9eb9-4a089c642ff4` succeeded. generations
`65035e63-707c-5133-8777-c282207bcf66` and
`9b676524-d6d3-5a5e-ba23-cdcc788c3b03` each have one accepted/completed model turn.
the first published a visible link/rationale; browser dismissal removed it;
the second actual generation respected suppression. separate real-owner fixtures
also proved in-flight work-grain suppression and explicit assistant preservation.

desktop keyboard/pointer, emulated touch and reduced `390×420` viewport passed.
an actual native software keyboard was not exercised. the isolated linux host
proved its declared namespace and single-file credential boundary; local named
storage and absent apparmor enforcement do not qualify production luks/apparmor.

release limits: the read-only production snapshot remains at `0241`. the isolated
full-chain rehearsal stops at `0246`'s unsettled-chat guard and rolls back. its
earlier history-reset decision must be reconciled before any release; see
[production release](tickets/production-release-pending-since-7dc68929b.md).
`origin/main` is 154 commits ahead of the specified baseline and already occupies
`0253`; porting must preserve its newer owners and use its canonical migration head.

trade-offs: hard cutover resets affected undo/replay and requires stopped old
clients; old journals are raw export-only. one row per fact can repeat titles.
refresh reaches the end if its retained tail was removed. removing temporary
tests gives up automated future regression detection. a narrow static comparison
now guards the generated browser tool contract after a real chat 409 exposed drift.

two unrelated observations remain recorded: [catalog failure classification](tickets/background-catalog-unavailable-loses-classification.md)
and [one dev css measurement error](tickets/reader-map-css-measurement-hmr.md).
[credential rotation](tickets/connections-verification-credential-rotation.md)
records the agent's tool-output mistake and required owner remediation.
