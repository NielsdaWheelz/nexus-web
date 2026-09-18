# cursor pagination duplicates request ownership

status: open · origin: 2026-09-17 cleanup audit, bf12a9720 · area: web collections · oi-162

`apps/web/src/lib/api/useCursorPagination.ts:35-36,135-155` splits one request
between a url builder, optional loader, and implicit fetch. five of six callers
already own their loader. it also treats every `ApiError` as recoverable,
unlike `useResource.ts:208`; podcast preview and conversation destination
render malformed responses as retryable load failures. stats compensates with
its own defect check at `StatsPaneBody.tsx:1318`.

require one `loadMorePage(cursor, signal)` callback, keep decoding with its
caller, and classify same-system defects in the pagination owner using
`isSameSystemApiDefect`. remove the stats compensation.

acceptance: real react/browser checks preserve append, network retry, and
query-change cancellation; a malformed continuation reaches the error boundary.
run `./scripts/test`; remove temporary verification code after the check.
