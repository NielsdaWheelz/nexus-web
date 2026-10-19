# a new placement edit erases the prior uncertain command

status: open · origin: 2026-10-14 library picker design audit · area: web / library placement

problem: after a write loses its response, another ordinary edit can discard the exact unresolved command and its retry even though the earlier request may still commit.

dismissal has the same lifetime defect: `apps/web/src/lib/libraries/placementController.tsx:31-48` stores only the current session; `LibraryPlacementOverlay.tsx:47,57-65` keeps pending/retry in its keyed child. close or retarget unmounts that child while the request continues, losing failure recovery. imports already retain placement state above their picker.

evidence: `apps/web/src/components/libraries/LibraryPlacementOverlay.tsx:83-92` releases pending and retains a transport retry; `:146-148` clears it on the next command. `LibraryChooser.tsx:134-145` admits toggles when not busy, regardless of that failure. imports have the same hole: `apps/web/src/components/nexus/useAddContentSession.ts:1053-1089` admits an uncertain placement into a new command, then successful `readPlacement` replaces it with ready at `:898-904`. `docs/modules/add-content.md:81-82` explicitly says reads never erase uncertainty. source-derived, not fault-injected.

reproduce: lose the response to a placement write; choose another destination after the error appears. the prior retry is replaced or cleared. a reread alone cannot prove the first request has stopped executing.

prerequisites: define conflict scope and settlement for unacknowledged commands; retain existing explicit add/remove semantics.

fix: share placement command ownership across ordinary and import editors. retain unresolved command identity separately from inventory and later intent; block conflicting dispatch until ordering is established. do not confuse idempotent repetition with safe reordering.

acceptance: delayed/lost response followed by another edit, inventory refresh, picker dismissal or reopening cannot erase recovery, dispatch an unsafe conflicting command, or report an unknown result as confirmed.
