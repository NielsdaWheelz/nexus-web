# incoming proxy body can outlive its deadline

status: open
origin: 2026-10-15 suggestions publication transport review
area: web / api transport

`apps/web/src/lib/api/proxy.ts` `forward` awaits `request.arrayBuffer()` before
upstream fetch. its timeout aborts the upstream controller; it does not cancel
that incoming-body read. a client that stalls a post body can keep this owner
pending beyond its transport deadline. ordinary gets are unaffected. this is
pre-existing behavior, outside the suggestions read change.

before changing it, define intake budgets for structured requests separately
from uploads and streams. cancel the incoming body through its owning boundary.

acceptance: a deliberately stalled post body settles within its intake budget
and releases resources; normal uploads, streams, mutations and user cancellation
retain their contracts.
