# member search input qualification

one chromium lab fill completed with the member-search field empty and no search
request. the cause is unclassified; neither an application race nor a driver
failure was established. no user-typing failure or failed write was observed.

at source `cd7d935bbf85cb92151e6f83d35f1f594e787c17`, reopen a library’s members
inspector after resolving an unanswered role change, then search for an invitee.
run `20261103-090924-5a998ffd3f6e`, trace call `nhhq@291`, completed the single
`fill('invitee')`; the next snapshot’s live value was empty. member reads finished
during that fill. `apps/web/src/components/users/PeopleSearch.tsx:49,80,121` has no refresh-driven
query reset; the stable field id argues against remount but does not prove identity.

the same full command journey passed in both browsers with passive input/focus
receipts in `20261103-093135-e0aa58c223c5`. trusted input reached the same connected
field and its value remained `invitee`. extra diagnostic protocol roundtrips can
change timing, so that pass does not explain the original failure.

resolution requires evidence distinguishing failed input delivery, focus movement,
remount and controlled-value rollback under the failing ordering. capture events
without adding a roundtrip before the fill; compare real typing if it recurs. fix
only an established cause. another passing retry alone does not close this issue.
