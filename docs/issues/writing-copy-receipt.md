# save as a new note reports failure after the copy was saved

problem: `save as a new note` saves the copy first, then settles the original
draft against the revision shown at the click. the original editor stays
editable while the new page waits for its server acknowledgement. any committed
edit there in that wait changes the revision, so settling the original is
refused, and the decision reports a generic failure although the copy exists.

impact: the person sees `couldn’t apply this choice.` with `the conflict changed;
review the current comparison` and no `saved as a new note.` receipt. pressing
`save as a new note` again creates a second page with the same words. no prose
is lost: the original branch keeps its conflict and the newer input.

evidence (source at `d90ed1033`):
- `apps/web/src/components/notes/NoteNotices.tsx:267` binds `shown` to the
  rendered revision; `:288–291` awaits `saveAsNewNote` (which awaits the page
  admission's `settled`, `:245`), then `retire(shown)`, then the receipt.
- `NoteNotices.tsx:268–279`: any rejection from that sequence becomes the one
  generic `couldn’t apply this choice.` notice.
- retire paths: `NoteNotices.tsx:385` (`texts.resolveConflict(ref, "saved",
  shown)`), `apps/web/src/components/notes/WritingRecovery.tsx:240`
  (`resolveDraftConflict` or `discardDraft(review, { revision })`).
- the refusal: `apps/web/src/lib/notes/journal.ts:1916` (`the conflict changed;
  review the current comparison`); `discardDraft` refuses a changed revision the
  same way.

reproduce: open a note whose draft conflicts with a saved version; hold the
new page's create response; choose `save as a new note`; type in the original
editor; release the response.

proposed fix: once the copy is acknowledged, a refused settlement of the
original reports that state, e.g. `saved as a new note. this draft changed
meanwhile and still needs a decision.`, and does not offer the copy again for
the same displayed revision.

resolved when, in that reproduction, exactly one new page exists, the person
sees the saved-copy outcome rather than a failure, the original editor keeps
its newer input with its conflict, and a second click cannot create a duplicate
page from the same displayed revision.
