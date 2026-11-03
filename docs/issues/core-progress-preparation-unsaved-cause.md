# progress preparation is broader than unsaved position

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: progress preparation is broader than unsaved position.

evidence: ResourceActionsProvider.tsx:444 says `your position isn’t saved yet.`; lib/consumption/state.tsx:168 and collectionCommands.tsx:176 say `a reading or listening position isn’t saved yet.` for ProgressPreparationError. lib/documentReader/progress.ts:465 throws for any observation, including known Accepted; :481 also permits source-binding, noncanonical view or handoff without unsaved movement. lib/player/nativeEngine.ts:547 maps an unanswered fence.

counterexample: a durable native save receipt is known but the index observation fails: prepareFence throws; the three translators claim the position is unsaved.

smallest truthful fix: use a preparation fact, e.g. `couldn’t prepare the reading or listening position.`; keep retry and current fence behavior.

resolved when: accepted-but-unobserved and source-binding cases never claim known-unsaved state.

verification: source only; no lab run. root owns repository records and implementation.
