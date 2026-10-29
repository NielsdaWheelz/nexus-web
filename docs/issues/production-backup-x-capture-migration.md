# production backup lacks an original x capture

the unmodified `nightly/2026-10-28/database.dump` restores, passes the repaired
bibliography conversion 0322, then aborts before annotation conversion in
`migrations/alembic/versions/0324_x_capture.py:150`:
`RuntimeError: 0324 x source 01a1627e-bfd1-79d8-a3ea-a04c827487df lacks one dated original fragment`.

observed on `cde84058f97bf606510af3a694b90c2161a3e48a` in private lab
`20261028-202210-b2359c156cb4`. the restored postgres container and volume were
removed; production was untouched. this blocks full production-backup upgrade
qualification and paired release, not static consistency or isolated annotation
conversion. see [x capture release](release-x-captures.md) for the owning census.

inventory the source's retained provider evidence, fragment count/timestamp,
authored bindings and saved references. recover the original only from proved
historical evidence, or obtain an explicit owner disposition. do not fabricate a
capture date, silently discard writing, or bypass migration refusal.

resolved when the same corpus passes the normal upgrade through current head and
all preserved writing, reference and source-prefix checks.
