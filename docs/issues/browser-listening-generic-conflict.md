# browser listening generic conflict

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: browserEngine.ts182-189 assumes every listening PUT409 carries canonical details.current; destructuring undefined throws TypeError for edge-owned generic busy409.

impact: ordinary refused listening sample can escape its existing recovery and crash instead of remaining retryable.

evidence: /media/{id}/listening-state route playback.py70-74 calls consumption/state.py105 record_listening. only E_STALE_LISTENING_REVISION at116 supplies canonical observation118-120. edge.py93-99 emits E_RESOURCE_CONFLICT for DatabaseBusyError without details.current. reproduce by that owned transaction busy while sample saves.

minimal proposed fix: parse/adopt canonical only when code is E_STALE_LISTENING_REVISION. other409 uses existing refused-write branch, keeps queued sample and emits Unsaved/retry as already defined. no wire or backend change.

resolved when generic409 preserves sample without TypeError and actual typed reset still adopts canonical epoch. root owns repository adoption; source-qualified, no lab run here.
