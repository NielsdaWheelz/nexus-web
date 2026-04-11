# Database

## Scope

This document covers PostgreSQL schema rules, query patterns, and DB-specific conventions.

## Schema

- Every table has a primary key.
- Primary keys are UUID `id` values.
- Do not expose database IDs to users.
- Every table includes `created_at timestamptz not null default now()`.
- Functionality that depends on a database lives in the same module as its migrations.

## Foreign Keys

- Use the database's default non-cascading delete behavior.
- Do not use `ON DELETE CASCADE` or other database-level cascading operations.
- Cleanup is explicit in application code.

## Timestamps

- Use `timestamptz` for instants, not `timestamp`.
- Compare against DB-stored timestamps with `now()` in SQL, not the application clock.
- The database is the authoritative clock shared across all app servers.

## Time Intervals

- Time intervals are right-open: `[start, end)`.
- `expires_at` is the first moment of invalidity: active while `now < expires_at`, expired once `now >= expires_at`.

## Indexes

- Do not add indexes speculatively. Add them when a query pattern on a high-volume table needs one.
- Use database uniqueness for true schema-owned keys: primary keys and real local alternate keys.
- Do not use database indexes or unique constraints to encode application-level ownership or correlation invariants.

## Query Patterns

- Do not use `INSERT ... ON CONFLICT` to merge insert and update logic.
- Use an explicit SELECT to check for an existing row, then INSERT, UPDATE, or DELETE accordingly.
- This is safe inside SERIALIZABLE transactions — concurrent conflicts cause a serialization failure that triggers a retry.
- Do not use row counts (`rowcount`) to determine control flow. That is the SELECT's job.
- Assert that row counts match expectations after a mutation as a defect catcher.
- See [concurrency.md](concurrency.md) for the broader locking and sequential-equivalence rules around these patterns.

## Transactions

- Use SERIALIZABLE isolation for transactions that require sequential equivalence.
- Do not run non-DB side effects inside a DB transaction — they cannot be rolled back on serialization retry.
- See [retries.md](retries.md) for retry-boundary rules such as in-memory state not rolling back across retries.
