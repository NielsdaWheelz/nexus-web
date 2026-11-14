# invalid-view facts lack the body gutter

library/search invalid-view facts begin at the pane edge while ordinary body content is inset. this makes recovery text inconsistent with the surrounding layout.

evidence: collation candidate 20261114-131504-57a5023849f4, chromium-dark-case-04-1.png and chromium-dark-case-09-1.png; invalid returns in LibraryPaneBody.tsx and SearchPaneBody.tsx render feedback outside ordinary body spacing. the behavior predates the collation.

resolve when invalid-view facts and their recovery verbs use the owning pane body gutter at desktop and phone widths without adding a separate feedback layout.
