# an unconfirmed library creation instructs and says "confirmed"

status: open · origin: 2026-11-02 import content sheet (slice 2), open point 6 · area: libraries / copy

`CREATION_UNCONFIRMED` (`apps/web/src/lib/libraries/create.ts:13-17`) reads
`library creation wasn’t confirmed` / `check your connection, then retry this
creation.`. feedback-homes' floor (`docs/feedback-homes-spec.md`, copy rules)
bans `confirmed` and instructions, and spells an unknown write as `not sure …
it may have gone through.`. the import page's `into` creation shows it as its
`Field` through `useDestinationCreation`
(`apps/web/src/components/libraries/useDestinationCreation.ts:84`), and so does
placement (`apps/web/src/lib/libraries/placementController.tsx:260`). no import
lane holds these files.

impact: the import page's one library field breaks the copy standard every
other import surface keeps.

resolved when: libraries spell an unknown create as feedback-homes does, and
the page and placement show that spelling.
