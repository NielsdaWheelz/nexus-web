# new-page title bypasses close protection

the notes index's unsubmitted new-page title has no work-risk owner. closing that
pane can discard the title without a loss decision; inline pane management uses
the existing guard and does not repair this separate authoring owner.

evidence: `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx:63` calls
`useResourceDraft("Notes.NewPageTitle", () => "")` without a risk reader.
`apps/web/src/lib/resourceGraph/useResourceDraft.ts:57` consequently registers
no work owner. the baseline close probe received no confirmation and replaced
the final notes pane with lectern; it was rejected as a guarded-close oracle.

reproduce by typing a title on `/notes`, opening nexus and closing that pane
before creating the page. register this draft's actual loss risk at its owner,
including successful submission/transfer semantics. resolve with refused close
preserving the title and accepted close discarding it exactly once.
