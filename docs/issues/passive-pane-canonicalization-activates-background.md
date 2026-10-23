# passive pane canonicalization activates background panes

source-traced: a passive completion effect calls pane `replace` without
`activate: false`. `lib/panes/paneRuntime.tsx:127-141` forwards the omitted option;
`lib/workspace/store.tsx:484` defaults it to true.

`app/(authenticated)/media/[id]/MediaPaneBody.tsx:119-121`: an accepted-source
read settles and canonicalizes its media identity. initial reads run even when
the pane is inactive; polling requires visibility, not activation.

paths above are relative to `apps/web/src`. this completion can activate its
background pane and dismiss another pane's active surface. the same cause was
observed for restored browse previews during shared-controls qualification;
that preview path is fixed separately. this media path has not been reproduced
in the browser. the retired new-page path's replacement,
`app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:90-93`, explicitly passes
`activate: false`; it no longer contributes this defect.

preserve the active pane while replacing the provisional media identity. prove
resolution by switching to another pane before the real read completes:
the original visit canonicalizes, while active pane and its open surface remain
unchanged. explicit user navigation should still activate its destination.
