# repeated libraries panes share accessibility ids

status: implemented; final physical acceptance pending
origin: 2026-10-14 libraries-pane design review; checkout `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / libraries accessibility

implementation and browser evidence: [verification receipt](../libraries-creation-verification.md).
keep this cutover record until the remaining physical acceptance and final cleanup.
the findings below describe the pinned baseline.

planned resolution: [libraries creation plan](../libraries-creation-plan.md).

`apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:355-358`
uses the literal `library-invitations-heading` for every invitation inbox.
:441,455 likewise uses `library-name-reserved` for every reserved-name error.
multiple index panes can coexist, so simultaneous inboxes or reserved-name
errors repeat ids and make aria references ambiguous. source finding; no
multi-pane assistive-technology reproduction performed.

prerequisite: none. allocate ids per mounted pane with the existing react
`useId` pattern and connect each label/description to that instance. deleting
the inline creation form may remove its error id, but not the invitation id.

acceptance: two index panes with the relevant states have unique ids and each
aria reference resolves to its own pane's label or error.
