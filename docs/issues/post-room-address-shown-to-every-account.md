# every account sees the Post Room address

status: open (spec defect 5 of the ingest reauthor, 2026-10-14; multi-user only).
area: post room / settings (`python/nexus/api/routes/me.py`, `python/nexus/api/routes/email_ingest.py`).

problem: `GET /me` returns `email_ingest_address` to every account, and Settings →
Account shows it, but mail to that address files only into the library of the
account `EMAIL_INGEST_OWNER_USER_ID` names.

impact: none while nexus has one user. a second account would forward mail into
someone else's library and never see it.

evidence: `R/me.py` answers the configured address unconditionally; the route
resolves the inbox owner from config alone.

resolved when: only the inbox owner sees the address (or each account gets its
own address and the route resolves the owner from the recipient).
