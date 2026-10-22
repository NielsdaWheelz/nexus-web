# passive pane canonicalization activates background panes

source-traced: two passive completion effects call pane `replace` without
`activate: false`. `lib/panes/paneRuntime.tsx:127-141` forwards the omitted option;
`lib/workspace/store.tsx:484` defaults it to true.

- `app/(authenticated)/media/[id]/MediaPaneBody.tsx:123-125`: an accepted-source
  read settles and canonicalizes its media identity. initial reads run even when
  the pane is inactive; polling requires visibility, not activation.
- `app/(authenticated)/pages/new/NewPagePaneBody.tsx:161-163`: acknowledged page
  publication canonicalizes its provisional visit. the write owner marks
  `published` from its asynchronous completion; this effect is not a new user
  opening gesture and does not check whether another pane became active.

paths above are relative to `apps/web/src`. either completion can activate its
background pane and dismiss another pane's active surface. the same cause was
observed for restored browse previews during shared-controls qualification;
that preview path is fixed separately. these two paths have not been reproduced
in the browser.

preserve the active pane while replacing these provisional identities. prove
resolution by switching to another pane before each real read/write completes:
the original visit canonicalizes, while active pane and its open surface remain
unchanged. explicit user navigation should still activate its destination.
