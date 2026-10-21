# recovery discard can strand retained explicit composer handles

source review of the same raw-reference discard path found analogous retained
owners. `ResourceComposer.tsx` ignores a missing canonical row and `journalFor`
keeps returning its deleted handle; its next checkpoint throws `the item draft
is no longer open`. `media/[id]/useSelectionComposer.ts` skips missing saved rows,
then throws `the passage draft is no longer open` on the next edit.

both show a memory-only failure, but their retained local body has no journal
entry for account export. this needs a real retained-pane recovery-discard case
before an owner-level repair. resolved when discard abandons the old authored
revision and subsequent edits obtain a fresh checkpoint/export owner, or a
visible owner refusal preserves the original branch.
