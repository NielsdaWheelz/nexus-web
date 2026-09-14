# useResource publishes defects but never their clearance

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: resource cache / pane failure containment

## what is wrong

`apps/web/src/lib/api/useResource.ts:97` publishes failures to `onDefect` but
never publishes a clearance, while `:154` internally clears a superseded defect.
a consumer that latched the defect therefore keeps showing it after the resource
has recovered.

## prerequisites

the clearance cannot be emitted alone: `useNexusController.ts:447` is
`observeDefect = (error) => setDefectState({ error })`, so an emitted `null`
would be stored and `Nexus.tsx:226` would throw `null` into the boundary — a live
crash. the consumer must accept a clearance in the same change.

## proposed fix

give `onDefect` an explicit two-arm contract (a defect, or its clearance for a
named request identity), make `useNexusController` clear rather than store on the
clearance arm, and keep the defect fenced by the request identity that produced
it so a late clearance cannot erase a newer defect.

## acceptance

a pane whose resource read fails and then succeeds clears its notice without a
reload; a clearance arriving after a *newer* failure does not clear the newer
one. observe the current behaviour failing first.
