# x author-thread search silently omits older replies

status: open; production cutover blocker
origin: 2026-10-14 x-title production cutover, source `134f4f4c3ba4f22166def330b4f3f06b71e0de17`
area: x source acquisition / saved-position preservation

`python/nexus/services/x_client.py:160–182` calls `/tweets/search/all` without
`start_time`, then labels an exhausted response as complete thread enumeration.
[the provider's full-archive contract](https://docs.x.com/x-api/posts/search/quickstart/full-archive-search)
defaults this request to the last 30 days. older threads therefore lose earlier
posts; an absent cursor permits that incomplete replacement to publish. this
omission also existed in the pre-cutover client.

production media `114a5cc0-bed9-4f3c-b069-b84702abfdd9`, frozen refresh attempt
`8f823c11-40c0-40c9-a7c3-cddd458a4427`, failed with
`E_SOURCE_POSITION_UNMAPPABLE`. its retained thread has posts
`2070083457024176194`, `2070084426650857829`, `2070118982854529169`.
one detached acquisition in the separate 512 mib migration service at
`2026-10-14T22:49:07Z` returned only the first post, created `2026-06-25`, and
reported `exhausted`. the saved terminal cursor is offset 134 in a 134-character
fragment; its complete fragment and exact 64-character window each have zero
matches in the replacement. the old readable publication and cursor remain
intact. no diagnostic publication, cursor edit, admission or retry occurred.
sanitized evidence: `/private/tmp/nexus-x-titles-proof-20261014/archive-range-live-red.log`.

final first-census observation: 52 successful snapshots each have exactly one
title job; all 28 successful author-thread snapshots contain exactly one primary
post. the second refused source is media
`8e08157a-2584-41fd-a5e0-8ffe4bb9a415`, attempt
`921a0480-d9c1-4c60-a3c8-aa8ccf893400`, also
`E_SOURCE_POSITION_UNMAPPABLE` with its readable copy retained. the manifest
reports 54 accounted targets, two failures and nine settled child titles;
accounting completion does not establish source completeness.

source correction qualified locally: every archive-search page now includes
`start_time=2006-03-21T00:00:00Z`, the provider's exact accepted floor confirmed
by its 400 validation response (`archive-range-provider-boundary.json`). two
temporary boundary checks failed before the change and pass after it: a reply
permalink retains preceding posts across pages, and the existing post/page
budget still stops with `post_limit`. at `22:58:00Z`, detached corrected
acquisition restored the three known `114a` posts; its saved fragment and
64-character window each match exactly once at the same terminal offset 134.
receipt: `archive-range-receipt.json` in the private evidence directory; it retains
exact source/cursor identities, offsets, hashes and match locations. temporary
checks and raw source fixtures were deleted after qualification.
production deployment and ordinary recovery remain outstanding.

the second `8e08` refusal has a separate proven cause: unchanged inline quote
content was replaced by an embed caption. see
[the quotation-position ticket](x-inline-quote-refresh-loses-saved-position.md).
missing-root ancestor selection is also a separate existing limitation, recorded
in [its ticket](x-thread-missing-root-drops-available-ancestors.md).

prerequisite: confirm the missing replies through an explicitly bounded
full-history search; do not presume that missing search results prove deleted
posts. fix the provider query's time range at acquisition, preserving the
existing post/page budget. the lower bound must include preceding posts when
the imported url names a later reply. no cursor guessing or database rewrites.
after deploying the fix, use ordinary source admissions to reacquire affected
author-thread census targets and settle their exact title obligations; preserve
the original cutover receipts.

acceptance: historical multi-post threads survive import and refresh; an old
reply permalink includes its permitted preceding chain. the live refused
cursor maps uniquely to its unchanged passage after complete acquisition, or
a separately evidenced source edit remains an explicit unresolved exception.
the cutover accounts for every affected source/title obligation without
claiming incomplete captures as successful full-thread refreshes.
