# block cut needs a complete branch clipboard contract

block cut is disabled. ordinary text cut and copy of selected visible items
remain available. editable bodies copy by value; terminal and other reference
appearances copy by reference, including references to notes.

problem: current block copy serializes selected visible rows only.
branch-preserving removal keeps folded descendants and internal
links, but those descendants would not travel through that clipboard payload.
combining the two operations would misrepresent a branch transfer.

evidence: `OutlineController.copy` in
`apps/web/src/lib/notes/outlineController.ts` retains visible-row serialization
and consumes block cut without mutation. `apps/web/src/lib/notes/clipboard.ts`
defines flat copied items. there is no full branch clipboard capture.

resolution requires an explicit branch cut/paste contract covering folded and
unloaded descendants, repeated resources, cycles, note identity, clipboard
failure, and undo. qualify complete transfer without losing descendants or
changing independent links before re-enabling block cut. no recursive clipboard
loader or compatibility path belongs in the current range-editing slice.
