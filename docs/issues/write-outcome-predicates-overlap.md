# three predicates classify a sent write's failure

status: open · origin: resource references re-slice port onto main, 2026-10-19 · area: api client (web)

three predicates each partition a sent write's failure, with different sets:

- `isRefusal` (`lib/api/client.ts:87`, #693): a modeled 4xx other than 401 is refused,
  so nothing changed; "anything else a sent write meets leaves its outcome unknown".
  callers: `libraries/placementController.tsx:180`, `libraries/create.ts:40`,
  `collections/order.tsx:132`.
- `outcomeUnknown` (`lib/api/client.ts:98`, the re-slice): `E_NETWORK`, `E_UPSTREAM`,
  `E_UPSTREAM_TIMEOUT` are unknown; callers treat any other unmodeled code as a defect.
  callers: `resourceGraph/links.ts:164` (relation removal; in effect chat context
  detachment, since unlink errors reach it only after the queue) and
  `actions/catalog.ts:355` (action failures).
- `isWriteRejection` (`lib/notes/writes.ts:98`, the tab write queue since #683): a 4xx
  whose code is in `REJECTIONS` is rejected; statuses 0/429/502/503/504 are transport and
  retried with backoff; anything else is reported and retried when nudged. callers: the
  queue's pump (`writes.ts:195`, `:228`), so every outline write, link create and undo,
  and `resourceGraph/useReferenceInput.ts:204`.

they agree on transport failures and on modeled refusals. they disagree on the rest: a
same-system defect (`E_INTERNAL`, `E_UNKNOWN`, `E_INVALID_RESPONSE`) is "unknown" by
`isRefusal`'s comment, a defect by `outcomeUnknown`'s callers, and a held, reported write
by the queue; a 4xx other than 429 outside `REJECTIONS` is refused by `isRefusal` and held
by the queue.

impact: a write owner choosing one predicate may resend after a defect where another
surfaces it; none does today, afaict.

resolved when: one predicate owns the partition (refused, unknown, defect) and the other
two call it, or the three are documented as its parts and each comment says which a
defect is.
