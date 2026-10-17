# release the mobile workspace contract

status: pending deployment
origin: 2026-10-16 mobile palette integration on main `8b609e0e5`
area: release / workspace sessions and client pairing

this change advances wire 9 to 10 and database head 0291 to 0292.
0292 deletes saved `workspace_sessions` for the required nullable visit title
hint. the owner approved losing saved tabs/history; library content, credentials
and consumption are unchanged. there is no old-shape reader or downgrade.

release through the existing controller with stopped writers, a verified
pre-migration backup and exact-head checks. pair the generated wire-10 web,
extension and signed android release with the backend. the local qualification
apk is evidence, not a signed release artifact. do not replay the historical
mobile-only 0287 migration or wire-2 constant.

done: deployed api/web identities and database head agree on the release,
wire-10 clients save strict title hints, old clients receive 426 before writes,
and the matching signed apk is available. pr merge alone does not establish
deployment. plan and verification evidence belong in the pr.
