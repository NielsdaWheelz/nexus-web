# distraction-free focus mode has no visible effect

source finding on 2026-11-12; not rendered. `cmd/ctrl+shift+f` cycles off →
`distraction_free` → `paragraph` → `sentence` in
`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx`. `MediaPaneBody.tsx`
sets `data-focus-mode`, but the reader painter in
`apps/web/src/lib/documentReader/text/paint.ts` acts only on paragraph and
sentence; no reader of the distraction-free attribute was found.

impact: the shortcut's first step and the corresponding reader setting appear
to do nothing, despite the stated focus-mode rationale.

resolved when: the mode has a defined visible effect, or the responsible owner
removes it consistently from the cycle, setting and profile wire.
