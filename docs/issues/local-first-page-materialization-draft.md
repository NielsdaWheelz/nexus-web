# page materialization retires the composer

the local page owner keyed its body by `new` and then the committed uuid. title
autosave replaced the route and remounted the body during the same authoring
visit, risking input and focus loss. `ResourceComposer` also omitted its existing
draft owner's loss-risk callback.

frozen `4b67ecead`, disposable run `20261025-130529-81dea80e6306`: firefox entered
a page title and note, clicked save, then found an empty composer and no note row.
the browser's localhost offline exception was still enabled, so that run is not
offline proof. the component identity defect is independently visible in
`pages/[pageId]/PagePaneBody.tsx`; the missing risk belongs to
`components/resources/ResourceComposer.tsx`.

the fix preserves the minted page identity across its route replacement and
registers actual unsent composer input with the existing work guard. resolve
after the mounted case preserves draft and focus without a materialization
prompt, ordinary exit warns about unsent input, and save produces the local row.

qualification remains open: frozen `45d0c2a33`, run
`20261025-135309-1e26f6669258`, proves network denial and local title creation,
but firefox's element-send-keys command leaves the composer empty before save.
the corrected text assertion times out. run `20261025-140418-461e04099850`
records the same connected composer node throughout, with no removal: gecko's
element-send-keys places its caret outside prosemirror's body. trusted click
before typing works; an independent bare-editor control also passes keyboard
tab plus trusted key actions. the driver now clicks first. this is not evidence
of remaining product input loss; the full save/reopen case still must pass.
