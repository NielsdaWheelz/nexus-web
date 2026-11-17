# the reader's passage field says `note or question`; text typed there did not become an annotation

found 2026-11-16 at 839bb918b, photographing the notes in a lab for a redesign.

## problem

in the pdf reader, after highlighting a passage, the selection popover offers one
field labelled `note or question about passage…`. text typed and submitted there
was not found afterwards as an annotation on the highlight: not in the margin
card, not on reopening the highlight. the field is not an annotation composer in
every state; one input serves two destinations and the label does not say which
a given submit takes. whether the lab's text was dropped or sent to the
librarian is not established.

## impact

a reader who types a note and presses the wrong submit (or reopens an existing
highlight) loses the sense of where the text went, and may believe it was saved.

## evidence

the component is `SelectionDock` (`apps/web/src/app/(authenticated)/media/[id]/SelectionDock.tsx:444-445`);
state is `useSelectionComposer.ts`.

- a fresh draft (`bodyRole: "annotation_or_question"`, `useSelectionComposer.ts:200`)
  has three submits for the one field: enter on desktop or the `save annotation`
  button saves the text as the highlight's annotation (`SelectionDock.tsx:362, 397,
  449`; `submit` `Save`, `useSelectionComposer.ts:351-366`); cmd/ctrl-enter or
  `ask librarian` sends it as a chat question (`askLibrarian: sendChat`, `578-579`,
  `SelectionDock.tsx:364, 410`); a colour swatch creates the highlight with
  `annotation: null` and leaves the typed text in the draft (`note` is non-null
  only for `Save`, `useSelectionComposer.ts:319, 370-371`).
- reopening an existing highlight creates a draft with `bodyRole: "question"`
  (`useSelectionComposer.ts:200`): the label becomes `question about passage`,
  `Save` is refused (`307`), `onSave` is not wired (`SelectionDock.tsx:449`) and
  the only submit is the librarian. editing the annotation there goes through the
  separate `edit annotation` action and `HighlightAnnotation`
  (`SelectionDock.tsx:351-358, 418-427`). text typed in the field after reopening
  therefore cannot become an annotation by any submit.
- `submit` returns without any message in several cases: an existing
  `issue`/`operation`/active reference, link or attachment
  (`useSelectionComposer.ts:304-307`), and a just-committed highlight not yet in the
  local reads (`310`). the draft keeps the text, so it looks unsubmitted rather
  than refused.
- a lab photograph taken during the survey (not kept in the repo). to reproduce:
  select a pdf passage, pick a swatch, type in the field, press enter; then
  reopen the highlight and type again.

## open question

decide whether the field should name its destination (separate note and question
inputs, or a visible mode), and whether typing in a reopened highlight's field
should offer an annotation at all. the lab's lost text is probably one of the
paths above; a run that records which submit was pressed would settle it.

## resolved when

in a fresh draft and in a reopened highlight, the field's label and affordances
state where the text goes, and text submitted to the annotation path appears on
the highlight's card and on reopening.
