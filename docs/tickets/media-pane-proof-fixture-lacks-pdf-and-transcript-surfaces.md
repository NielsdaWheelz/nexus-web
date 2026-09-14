# four fixed media-pane defects have no proof: the fixture has no PDF or transcript pane

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: media pane proofs / fixtures

## what is wrong

four defects were fixed in `MediaPaneBody.tsx` with no new proof, because the
shared fixture
(`apps/web/src/app/(authenticated)/media/[id]/__tests__/mediaPaneFixture.tsx`)
is EPUB-only and five other proofs depend on it. bolting half a fixture onto it
would have produced a fixture more permissive than the real dependency. what each
needs:

- a **PDF pane** (`PdfReader` + pdf.js + a signed source) for the two PDF-path
  fixes.
- a **transcript pane** (media of kind `podcast_episode`, the `/fragments` seed,
  `TranscriptPlaybackPanel`) plus an injected transcript Find or Fragment-highlight
  defect.
- the pane's secondary **Evidence** surface opened while the descriptor read is
  failing.
- publication data that already violates its own contract (an anchor href
  starting with `#` plus a degenerate `epub_target.href_path`).

## prerequisites

whoever owns the PDF and transcript fixtures should build them beside the media
fixture rather than inside it, so the five existing consumers are unaffected.

## proposed fix

add the two pane fixtures and the two adversarial data shapes, then write the
four proofs.

## acceptance

each of the four fixed behaviours has a proof that fails when its fix is removed.
