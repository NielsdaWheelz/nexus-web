# shared memory does not enforce the local turn horizon

the shared archive has no nexus question-sequence filter.
`python/nexus/services/memory_capture.py:101` (`append_turn`)
exports in settlement order; a later queued question can be cancelled and exported
before an older waiting question starts. `universal_memory.ViewPage` carries
central ready/admitted positions, not a nexus sequence bound (`universal-memory`
`a788c885`, `src/universal_memory/types.py`, `ViewPage`/`ViewInput`). shared reads and
automatic orientation can therefore expose that later settled question to the
same owner, although local message tools and attachments exclude it.

impact: the local horizon is not an isolation promise for cross-source shared
memory. current input still governs the turn; a remembered request grants no
permission. no cross-account grant is added.

reproduce: queue two questions behind an active turn, cancel the last, let its
capture publish and compact, then start the older waiting question with memory.

resolved when the shared service supports source-aware horizon filtering without
incomplete tree coverage, or the owner explicitly accepts execution-time shared
history as the exception. this change documents the existing limitation; it does
not silently claim the local horizon covers the shared archive.
