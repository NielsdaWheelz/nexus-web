# saved reader lacks render environment

real Samsung native run `20261025-152741-7fcbdc583121`, source
`ca2558c79529e79424c3c9cacd3bab5783468758`, passed offline writing,
real PDF download and pinned-copy generation. cold opening that downloaded copy
then rendered a blank shelf document. retained Chromium pid10815 reports
`Uncaught Error: RenderEnvironmentProvider is missing` from
`https://appassets.androidplatform.net/shelf/assets/index-VYL4KqK0.js:36`.

shared annotation/editor consumers require the render-environment owner, absent
from the shelf root. establish the shelf's actual host environment at that
boundary without broadening its native capabilities. resolve with the same
actual cold saved-copy journey plus offline annotation and source-frame denial.

implementation now establishes the existing `RenderEnvironmentProvider` at
`apps/web/src/shelf/main.tsx`, outside the existing mobile viewport owner. facts
name the actual packaged android host and the document’s locale/timezone/instant;
viewport kind remains the existing live media-query owner. no workspace provider
or native capability was added. the same handset cold-copy/annotation journey
remains the resolution gate.

native16 at `72b0` qualified the render-environment and feedback-layout fixes:
the saved pdf opened offline, real source selection and note composition worked.
saving then mounted `ReaderAnnotation.AttachedNoteRow` → `ActionMenu` →
`useMobileChromeHold`, which threw `mobile chrome hooks require MobileChromeProvider`.
`ActionMenu` reads that controller even while its menu is closed.

the shelf root now also mounts the existing `MobileChromeProvider` inside its
actual viewport owner. this controller owns presentation holds only; it adds no
workspace, account or native capability. the shared saved-editor chain's other
required providers are present. actual attached-note save/edit/menu/reopen/sync
and denied source access still require the rebuilt handset qualification.
