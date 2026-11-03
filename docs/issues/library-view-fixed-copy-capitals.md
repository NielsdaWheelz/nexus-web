# library facts contain fixed uppercase format names

problem: empty library facts render “no PDFs in this view.” and the EPUB variant.
these are product-owned nouns, not user titles. the name-validation Field also
embeds fixed “All”, despite the Line rule allowing only user-data capitalization.

source at06315275: `apps/web/src/lib/libraries/views.tsx:15,67-68,87-88`;
`app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:282` consumes emptyEntries.
TYPE_PLURALS belongs only to this empty-state producer; ordinary ENTRY_TYPES
filter labels are a separate record and need no change.

fix only fixed fact literals to lowercase, preserving names supplied by users,
ordinary labels, name validation, filter meaning and recovery verbs.

resolved when actual closed Line variants are lowercase, fit fourteen words and
pass independent source review and the canonical static gate.
