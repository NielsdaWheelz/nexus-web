# a dead prop on the quotation figure

status: open · found 2026-11-12 by search; rechecked at `09c14e68f` · area: web / resources

`ResourceQuotation`'s `renderSourceControl` prop
(`components/resources/ResourceQuotation.tsx:23,29,79`) has no caller in
`apps/web/src`. the module docs no longer name it.

`MarkdownPreview` and `TextPreview`, once listed here, gained a caller in #934
(`components/chat/LibrarianReferences.tsx:264`).

impact: readers take the prop for a live seam; the chat quote survey did.

resolved when it is deleted or has a caller.
