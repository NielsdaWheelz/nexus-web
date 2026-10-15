# resource menu inverse verbs use checkbox state

status: open
origin: 2026-10-14 menu design audit
area: web / resource actions / accessibility

rechecked against `7bc7c8a13`: `apps/web/src/lib/actions/catalog.ts:98-100`,
`:135` and `:144` name inverse commands for completed consumption, lectern
membership and subscription. `apps/web/src/lib/actions/project.tsx:468`,
`:537` and `:554` pair those labels with the current state's checked value.
the projection at `:157-160` makes toggle state;
`apps/web/src/lib/ui/actionDescriptor.ts:40-47` renders `menuitemcheckbox`.
examples are "mark as unread, checked" and "unsubscribe, checked": the checked
value describes the resource, while the label describes its inverse operation.
the resource-action reauthor moved the owners but retained this mismatch.
this is source evidence, not a screen-reader reproduction.

prerequisites: none. choose one semantic contract at the resource projection:
an inverse verb is an ordinary command; a checkbox has a stable state label.
prefer ordinary commands for the existing inverse labels. include "remove
download" (`catalog.ts:125`, `project.tsx:393-396`) in that correction.

acceptance: read/unread, lectern membership, subscription and offline commands
have coherent visible and accessible names in both states. genuine stable-label
toggles retain checked semantics. manually verify keyboard and a screen reader;
preserve execution, capability checks and confirmation ownership.
