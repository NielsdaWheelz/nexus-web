# imports harness lacks browse-preview Add and note-attachment journeys

status: open · origin: 2026-10-10 imports reauthor (cleanup/imports-reauthor) · area: verification / imports

the imports design's verification list (§12) names two consumer surfaces the imports harness (`campaign-artifacts/2026-10-09/imports/harness`) still does not drive: E4, browse preview Add (`app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx` → `addMediaFromUrl`), which needs a sealed browse target from a faked discovery source; and the note-body attachment half of E3 (`components/notes/NoteBodyEditor.tsx` → `uploadIngestFile` + `captureErrorFeedback`), which needs a ProseMirror file drop. the reauthor only moved their imports (`lib/imports/ingest.ts`, `lib/imports/copy.ts`); the connections half of E3 (E3 journey), share (S1, S2) and the media pane (E2, H2) are driven. the nav harness's `M11.mobile-account-menu` was not rerun (other ports and resources); N2 and P16 cover the same account-menu count in this harness.

fix: add a browse fake (one candidate whose preview kind takes the `addMediaFromUrl` branch) and a note-attachment journey (drop one pdf on an empty note body; inject one refused upload).

acceptance: both journeys pass on the imports harness; a refused note attachment reads "Attachment wasn’t added" with the capture copy.
