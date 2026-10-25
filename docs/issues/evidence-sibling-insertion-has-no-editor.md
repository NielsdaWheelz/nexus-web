# reader-root sibling insertion has no editor host

problem: selecting an unanchored connections root and choosing `insert item`
opens session composer state but renders no editor.

evidence: unmodified `a09557224`, real browser lab
`20261025-134906-55006e56fd6f`, following journey. the discovery row selected,
its enabled outline command ran, then no `insert item` textbox appeared.
`evidence/model.ts:25` publishes sibling destinations with prefix `evidence`;
`ResourceOutlineRow.tsx:379-381` hosts only prefixes equal to the full occurrence
key. `EvidencePane.tsx` supplies no root composer host to `ResourceOutlineList`.
paths are under `apps/web/src/app/(authenticated)/media/[id]/` for evidence and
`apps/web/src/components/resources/` for the shared row/list.

impact: the direct root insertion command leaves an invisible editing state.
the same session's complete nested source outline can still insert a direct
media link; that path qualifies header pending-link behavior, not this defect.

fix: the reader-root presentation must host the existing `OutlineInsertionLine`
at its captured sibling slot, as `OutlineSurface` does, preserving its source,
position, mounted editor and focus. do not rewrite the destination as a child,
append somewhere else, or add a second composer owner.

resolved when the direct command shows one editor at the intended slot, supports
reference linking/cancellation, and admits the same captured direct-root write.
this editing-presenter repair is outside the controls presentation bundle.
