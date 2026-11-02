# `DestinationChooser`'s bulk selection lost its last caller

status: open · origin: 2026-11-02 import build, slice 2 lane b · area: libraries / chooser

the add panel was the only caller passing `{ kind: "Bulk" }` to
`apps/web/src/components/libraries/DestinationChooser.tsx` (`DestinationSelection`,
the `total`/`entries` arithmetic, `choose for all` / `remove from all`, the `applies to
{n} editable items` summary). it is deleted; every remaining caller (the import page,
placement, share, the extension popup, `DestinationField`) passes `{ kind: "Item" }`.

impact: dead branches and a one-member union that callers still spell out.

resolved when: the chooser takes the chosen libraries directly, the bulk arm and its
copy are gone, and each caller passes the list. it spans libraries, share and the
extension, so it waits for a lane that holds them.
