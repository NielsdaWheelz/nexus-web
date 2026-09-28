# Add Content keeps its own settlement-unknown placement machine

status: open · origin: 2026-09-28 pr-06 library placement reauthoring (cleanup/library-placement, claude session) · area: ingest-imports web

the `Libraries…` overlay now treats every placement write as idempotent: a
transport failure offers Retry, which resends the write, and a refused write
rereads the inventory. Add Content's bulk placement in
`apps/web/src/components/nexus/useAddContentSession.ts` (about L560-820) still
runs the older design on the same writes:

- `isPlacementSettlementUnknown` (L124) splits `E_NETWORK`/`E_UPSTREAM_TIMEOUT`
  rejections into an `uncertain` batch that is reread and decided per media
  (desired relation reached or not), with its own `Reconciling` placement state;
- when the reread shows the write landed, it publishes the placement bus by
  hand (`publishLibraryPlacementChange`, L794), because the failed write never
  reached `libraryPlacement.ts`'s own publish.

impact: two policies for one idempotent contract, and about 100 lines of
reread-and-decide code that a resend makes unnecessary.

fix: when the ingest-imports web row is reauthored, collapse it to "a failed
write offers Retry, which resends it", as the overlay does, and drop the
unknown branch, its `Reconciling` state and the manual publish.

resolved when: `isPlacementSettlementUnknown`, the `uncertain` reread and the
manual `publishLibraryPlacementChange` call are gone from Add Content, and a
bulk add or remove that hits a network blip succeeds on Retry.
