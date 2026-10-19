# supervisor imports retain unexplained memory growth

status: open
origin: 2026-09-10 imports cutover, phase 9; updated 2026-09-17
area: worker supervisor imports

fresh-interpreter measurements in the former linux runner showed 73 mib at
main, 92 mib at merge `e7c6d9fe`, and 77 mib after removing unintended orm/media
imports. the remaining 4 mib was attributed to `nexus.schemas.import_history`
(about 1 mib) and `nexus.services.import_history` (about 3 mib, including about
2 mib for `sqlalchemy.dialects.postgresql.JSONB`). that retained growth was not
examined further. the old 96-mib test threshold and its assertion are removed.

prerequisite: a current linux supervisor measurement. inspect whether the
remaining imports are necessary to supervisor work and remove unnecessary
product coupling if it still exists. do not recreate a memory-test harness.

acceptance: record current import residency and explain or remove avoidable
retention. this ticket does not establish a new automated memory gate.
