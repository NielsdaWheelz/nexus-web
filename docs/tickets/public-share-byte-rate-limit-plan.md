# public share byte rate limit

status: owner-deferred; production rule unchanged
origin: 2026-10-15 book release coordinator, exact main `1c07b5ae`
area: release / vercel firewall

staging `deploy/vercel/firewall/resource-sharing-bytes.json` failed with `Rate limiting is not available for this plan (401)`. the actual team is on active hobby. the subsequent firewall diff reports no pending changes. receipts are `coordinator/final1c07/firewall-*` and `vercel-plan.json` in the book-repair campaign artifacts.

the existing enabled 120-request/minute/ip rule still covers every public resource-share path. the intended split gives pdf/image byte reads 600/minute while retaining 120/minute for metadata. neither metadata editing nor publication was attempted. retaining the current rule may throttle an image-heavy shared book sooner; it does not remove existing protection.

the owner chose on 2026-10-15 to keep the current rule and defer the higher allowance. this is not a release blocker. retain the current rule and report the byte-read allowance as unqualified; no paid-plan change is authorized.

resolved when: the actual production firewall has the reviewed two-rule split and a bounded public resource-share check succeeds, or the product requirement is explicitly revised with its consequence recorded.
