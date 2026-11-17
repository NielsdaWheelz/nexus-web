# indenting a new child produced a tall temporary blank

reported twice in the `839bb918b` lab on 2026-11-16: after creating and indenting
a child, an approximately 4700px blank remained for at least six seconds, then
cleared. the photograph was not retained; cause is unestablished.

impact: ordinary writing moved rows thousands of pixels beneath the caret.
reproduce in a note with 100+ children: create a child under an earlier sibling,
indent it and observe the following rows.

source hypothesis: `apps/web/src/lib/notes/outlineController.ts` can retain a
dormant branch's measured height while withholding its presentation
(lines 1281–1286, 2160–2163). `branchHeights` includes descendant gap heights;
`outlineViewport.ts` also estimates unknown gaps. capture the affected row id
and `minHeight` before attributing the blank to either path.

resolved when: indent does not introduce an unexplained blank or caret jump,
including during branch wake-up. preserve legitimate virtualization gaps;
requiring every empty layout region to be one text row would be incorrect.
