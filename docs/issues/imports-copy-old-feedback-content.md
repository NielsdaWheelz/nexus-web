# imports copy still answers feedback-homes' old `FeedbackContent`

status: open · origin: 2026-11-02 import build, lane s2a review · area: imports / copy

the import spec retypes `FeedbackContent` in `apps/web/src/lib/imports/copy.ts`
to feedback-homes' `Line`. lane s2a could not: every value typed with it
(`STALE_NOTICE`, `CONFLICT_NOTICE`, `savedSourceReadFailure`, `loadFailure`,
`uploadCommandFeedback`, `captureErrorFeedback`, `AcceptanceFailure`,
`UNCONFIRMED`) is read only by surfaces outside the import lanes, which still
render the old `FeedbackState` and `FeedbackNotice`: the imports pane
(`components/imports/ImportsList.tsx`, `ImportActions.tsx`,
`ImportInspector.tsx`, `app/(authenticated)/imports/ImportsPaneBody.tsx`),
`MediaPaneBody.tsx`, `lib/actions/catalog.ts`, share (`ShareCapture.tsx`),
attachments (`useConnectionAttachments.tsx`, `NoteEditor.tsx`) and the add
panel (`useNexusController.ts`, `useAddContentSession.ts`). `UNCONFIRMED` and
`AcceptanceFailure` die with the add panel in slice 2 lane b.

impact: imports copy keeps two feedback vocabularies until its readers move; a
retype now would break their rendering.

resolved when: each reader renders `Line`, `copy.ts` answers `Line`, and no
import of `FeedbackContent` or `FeedbackTone` remains in `lib/imports`.
