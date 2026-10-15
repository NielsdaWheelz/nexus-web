# firefox favicon request failed during release qualification

status: open observation; cause unassigned
origin: 2026-10-15 session-entry final 0bd consumer qualification
area: web icon / browser network

while the isolated authenticated firefox context displayed `/version`, the
pre-armed bidi observer recorded `/favicon.ico` response status 500 followed
by fetchError, without response completion. `/version` completed with 200.
this predates the first bare `114a` navigation; no reader failure is inferred.

evidence: `/tmp/nexus-session-entry-release-20261014/firefox-qualification/final-0bd-network-snapshot.json`;
request timestamp 1792031768004 ms, response 1792031769339 ms, fetch error
1792031769340 ms. observer connection healthy; no raw headers/body retained.

impact: the tab icon request failed in this visit; persistent failure and its
server/browser cause are unestablished. ordinary reader qualification proceeds
independently. no additional production probe or source edit was made.

next: correlate this request with existing deployment logs or inspect the static
icon owner during its next ordinary observation. repair the confirmed owner.

acceptance: explain the retained failure and observe the ordinary icon request
complete successfully, distinguishing an observer/network error from an
application response.
