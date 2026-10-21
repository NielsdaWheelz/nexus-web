# api error predicate false branches

`isRefusal` and `isUnauthenticatedApiError` in
`apps/web/src/lib/api/client.ts` return `error is ApiError`, although each checks
only a subset of api errors. after a caller has established `isApiError(error)`,
a false result from either predicate incorrectly narrows `error` to `never`.
reading its fields then fails type checking even though other api errors remain
possible. `outcomeUnknown` exposed this defect during unsaved-work implementation
and now describes its checked code subset; these two predicates were not changed.

reproduce with an already-narrowed api error and a field read in the false branch
of either predicate. resolve by accurately typing each checked subset and verifying
its real callers through `./scripts/test`; keep runtime refusal/auth behavior.
