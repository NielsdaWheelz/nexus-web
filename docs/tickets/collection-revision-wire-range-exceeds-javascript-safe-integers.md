# collection revision wire range exceeds javascript safe integers

status: deferred. origin: 2026-10-04 independent source review. area: collections / revision contract.

at `c13ddb87c9b03b1904dcd047c79617a240544829`, `python/nexus/schemas/collection_page.py:16–22` permits revisions through signed int64 maximum. `apps/web/src/lib/api/collectionPage.ts:48–58` requires `Number.isSafeInteger`.

impact: the declared native number range exceeds the current browser representation. no oversized live revision is claimed.

prerequisite and fix: agree on a wire representation/range at the collection contract owner; retain the current browser safe-integer guard until that agreement is enforced.

acceptance: native and browser contracts accept exactly the agreed revision range, with preserved pagination, equality and continuation semantics.
