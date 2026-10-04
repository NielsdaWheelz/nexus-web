# author nonmedia work dates have no producer

status: open · origin: 2026-10-02 author retirement audit, base `2b7d7ac899826f0f4b03d271fd606ea28c53d207`
· area: contributors / read contract

the podcast and catalog-only author work outputs carry `date: str | None`, but
their sole producer always supplies null. `services/contributor_credits.py:57-59`
states that contract; its sql projects only `m.original_published_date` at :79
and joins media by the mutually exclusive media target at :89.
`services/contributors.py:437,448` forwards that value to the two output models
(`schemas/contributors.py:157,167`). the typed web projection retains the
unproduced nonnull conversion in `lib/contributors/api.ts:57` and carries it to the row presenter
(`lib/collections/presenters/presentContributorWork.ts:29,40`).

this is excess contract and conversion complexity, not evidence of missing user
data. no canonical podcast/catalog publication-date source was established.
the current author retirement preserves these response bytes and dates.

prerequisite: choose whether explicit known absence remains on the wire or
these two unused date fields retire in a separate contract change. narrow the
existing schema/domain to that decision and remove unproduced conversion
branches; do not invent a date source.

acceptance: real podcast/catalog author reads retain their intended undated
presentation and sort order; schema, web projection and presenter contain only
the chosen produced states. qualify any deliberate wire change separately from
the author rename retirement's byte-preservation proof.
