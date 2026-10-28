# accepted native outline window limit

v1 deliberately keeps the native bridge's 16 mib aggregate response cap for
the atomic `outline_window` read. combining formerly separate responses means
a sufficiently large window can now refuse admission even if each former
response would have fit. saved writing remains intact; the qualified
100,000-note workload fits. this is an owner-accepted limit, not an open
acceptance failure.

the contract lives in `docs/local-first-writing-spec.md` under commands and
local composition and in `docs/modules/notes.md` under atomic outline reads.
preserving every such oversized window would require a bounded multipart
response contract with one consistent revision, rather than raising the cap,
clipping projections or dropping writing. revisit only if that capability is
required; qualification must include an oversized window and unchanged writing.
