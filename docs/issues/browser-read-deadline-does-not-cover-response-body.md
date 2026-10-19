# ordinary browser reads lack a total deadline

status: open; suggestions are repaired
origin: 2026-10-14 lectern latency diagnosis, source `367da80e0`
area: web / ordinary read transport

ordinary `apiFetch` reads await the full response body without an operation
budget. `useResource` supplies lifecycle cancellation only. the unselected
proxy still releases its upstream timer after headers. retry policy permits
three attempts; individual header timeouts do not bound the logical operation.
proxy session resolution also precedes that upstream timer.

2026-10-15: suggestions now opt into one ten-second browser budget through
headers, body and retry waits, with a matching bff body-lifetime owner. actual
header/body stalls, retries, caller cancellation and unchanged ordinary/media/sse
controls pass; see the verification and transport receipt in #633. this deliberately
leaves other pages' budgets unchanged. an ordinary `/me` body held twelve seconds
still returns 200; that control confirms scope, not ordinary-read protection.

prerequisite: choose budgets for the remaining ordinary reads. reuse the shared
operation-deadline mechanism at each responsible owner; preserve stream/media
lifetimes and mutation reconciliation. incoming post-body intake is separately
tracked in [its ticket](proxy-incoming-body-is-outside-cancellation.md).

acceptance: remaining ordinary reads settle within declared total budgets under
header/body stalls and transient retries, with truthful feedback and distinct
caller cancellation. verify their affected user journeys independently.
