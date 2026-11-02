# an acquisition waiting behind another always loses an attempt

status: open · origin: 2026-11-02 import acquisition (slice 1) lab · area: ingest

two acquisitions by one account in flight at once (two tabs, the extension beside
the web, a share during an add): `accept_url_source` runs under
`retry_serializable` and opens with `users.lock_viewer`. postgres takes the
serializable snapshot at that first statement, before the lock wait, so the waiter
reads the holder's pre-commit state; every insert advances its library's
`order_revision` (`library_entries._ensure_entry_locked`), All included, so a
waiter behind an insert always aborts once and spends one of its attempts (six for
a url, three for upload and capture confirm), leaving the rest for the account's
background work (`lone-acquisition-exhausts-serializable-retry`). the intake takes
one acquisition step at a time (a link's accept or an upload's confirm, while puts
run two at a time) and share sends one link at a time, so one client no longer
races itself; two clients still can.

impact: a link refused with the removal-fence copy (`save needs review`, intake's
`changed`), though nothing changed.

evidence: lab run `20261102-004835-2055eadf6455`, add panel sending two at a time:
six of eight two-then-twelve runs refused one link; `api.log`
`db.resource_busy`, `accept_url_source exhausted after 3 transaction attempts`,
`SerializationFailure ... Canceled on identification as a pivot, during write` at
`INSERT INTO media` in `_new_media`. sending one at a time (run
`20261102-092517-c22f390699ed`): three of eight. both at three attempts; two at a
time with six attempts, and two clients, not measured.

fix, afaict: let a waiter's lost attempt not count, e.g. probe the viewer lock
`NOWAIT` and, when busy, wait for the holder outside the attempt before opening it.
idk how that reads against `nexus/db/retries.py`'s one-owner rule.

resolved when: two browsers on one account each send twelve links into one
library, two at a time, and all 24 accept with no `db.resource_busy` in the api log.
