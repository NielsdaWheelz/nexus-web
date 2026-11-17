# remaining wire 24 installed-client qualification

the owner deferred installed-client checks for the 2026-11-15 release at
`833eb09a7`, wire 24/schema 0346. that decision allowed publication after paired
deployment and packaged-byte checks; it is not a waiver for later releases.

subsequent historical observations cover part of that gap. android was upgraded
in place to 0.3.16/code 37; the installed apk matched the published hash, retained
its first-install timestamp and verified app links. during the backend move,
that installation retained login, accepted writing and received cross-device
text after a cold reopen on `b666d936f`.

the retained owned firefox profile passed offline writing, full process restart
and catch-up. signed extension 1.1.5 then survived a persistent update/restart
and resolved the original capture receipt without another ingestion on `d05d69bd1`.
this qualifies that owned profile, not the personal firefox installation, whose
1.1.4 update was owner-confirmed but not independently version-read.

android offline-to-online writing and the separate feature-specific handset
observations remain unqualified; cold reopen alone does not prove offline
writing. preserve client storage and record the exact installed version/source
when closing those remaining journeys. do not repeat the accepted journeys just
to obtain a newer receipt. historical evidence is in nexus prs #953–#958 and
`~/.local/state/nexus-backend-hosting-20261116/`.
