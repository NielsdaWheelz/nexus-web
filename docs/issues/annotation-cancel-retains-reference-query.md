# canceling annotation creation can retain its reference query

in native lab `20261104-224622-85ebc8520f5e`, compose `@` in a blank saved
highlight's annotation, leave its reference chooser open, accept creation's
cancel confirmation, then reopen annotation. the new creation clone restores
the old `@` query instead of a blank editor. no authored command was committed.

the actual cancel and reopen clicks are in that run's private
`artifacts/selection-annotation-android/native-events.json`; screenshot/body show
the revived query. ordinary typed cancel/reopen passed on chromium. the annotation
cancel and reference-draft lifetime paths were unchanged by the icon/settlement
repair. this does not establish behavior for every non-dock host.

`apps/web/src/components/notes/HighlightAnnotation.tsx:164–168` clears its creation
clone after approving loss, while `apps/web/src/lib/resourceGraph/useReferenceInput.ts:53–54`
retains an independently owned reference draft. establish the
correct discard boundary at those owners; do not hide it with a new editor key,
manual dom clearing or an account-wide draft purge.

resolved when accepted creation cancellation retires that creation's reference
input and reopening is blank, without losing another occurrence's retained query.
