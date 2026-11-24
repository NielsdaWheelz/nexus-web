# accepted native outline window limit

v1 deliberately keeps the native bridge's 16 mib aggregate response cap for
the atomic `outline_window` read. combining formerly separate responses means
a sufficiently large window can now refuse admission even if each former
response would have fit. saved writing remains intact; the qualified
100,000-note workload fits. this is an owner-accepted limit, not an open
acceptance failure.

the [notes contract](../modules/notes.md) owns atomic outline reads and their
native response cap.
preserving every such oversized window would require a bounded multipart
response contract with one consistent revision, rather than raising the cap,
clipping projections or dropping writing. revisit only if that capability is
required; qualification must include an oversized window and unchanged writing.

index-scrolling now requires bounded rich reads as well as bounded structural
ranges. the exception above describes the older outline release.
`compileOutlineWindows` permits up to 48 rich rows per slice and several slices
in one bridge answer. long notes or captured excerpts can still exceed the
aggregate cap. an inline retry can repeat the same request. keep one revision
while choosing a byte-bounded body batch, and give a detail too large on its
own a readable row-level failure. resolve with a paired apk and a real
oversized window that retains its slot and neighboring editing state.
