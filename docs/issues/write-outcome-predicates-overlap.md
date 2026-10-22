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
- `isWriteRejection` (`lib/notes/writes.ts:163`, the tab write queue): since the notes
  re-slice the queue's own partition is transport (0/429/502/503/504: resent with
  backoff) versus answered (the job ends); `isWriteRejection` decides whether an
  answered failure is a rejection (nothing changed) or a reported defect that may have
  landed. callers: the queue's pump and the owners that branch on it, correcting and
  re-minting after a rejection and resending the same ids after a defect: the outline
  unlink, the new page, `resources/ResourceComposer.tsx`, `resources/ResourceOutlineRow.tsx`
  (relation removal), `connections/useConnectionAttachments.tsx` and
  `resourceGraph/useReferenceInput.ts`.

they agree on transport failures and on modeled refusals. they disagree on the rest: a
same-system defect (`E_INTERNAL`, `E_UNKNOWN`, `E_INVALID_RESPONSE`) is "unknown" by
`isRefusal`'s comment and by the queue's owners, and a defect that replaces its surface for
`outcomeUnknown`'s callers; a 4xx other than 429 outside `REJECTIONS` is refused by `isRefusal` and a
failed, reported write by the queue.

impact: one 500 that may have landed is resent with the same ids by a queue owner and
stops the surface for another: the action runtime (`lib/actions/ResourceActionsProvider.tsx`)
and the reader's annotation verbs (`reader-annotation-verbs-stop-on-an-answered-defect.md`).

resolved when: one predicate owns the partition (refused, unknown, defect) and the other
two call it, or the three are documented as its parts and each comment says which a
defect is.
