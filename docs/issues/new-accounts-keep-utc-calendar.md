# new accounts begin with a utc calendar

problem: first sign-in does not adopt or offer the device's calendar zone.
`migrations/alembic/versions/0306_baseline_schema.sql:2010` defaults
`calendar_time_zone` to `UTC`; first account creation retains that default.

impact: the journal day and librarian morning turn at utc midnight until the
person visits account settings. settings now offers a differing device zone
and a searchable picker; first-run adoption remains outside that contract.

proposed fix: decide whether first sign-in should offer or adopt the device zone,
preserving an already selected account zone.

resolved when first sign-in makes that choice explicit and verifies the journal
date around the account/device midnight boundary.
