# Concurrency

## Scope

This document covers locking, TOCTOU handling, and cross-system mutation ordering. It does not cover transaction isolation or retry semantics — see [database.md](database.md) and [retries.md](retries.md).

## Locking

- All backend code may execute concurrently on different servers.
- Use locking when concurrent calls could produce results that differ from any possible sequential ordering.
- Do not lock when sequential equivalence already holds.
- SERIALIZABLE transactions handle this for DB-only operations.
- Do not add `SELECT FOR UPDATE`, advisory locks, or explicit row locking on top of SERIALIZABLE transactions.
- Nontrivial side-effect concurrency requires `justify-concurrency` explaining why parallel execution is safe and why the chosen bound is acceptable.

## TOCTOU

- When an operation depends on state that may be concurrently modified, use a check-operate-recheck pattern.
- Check preconditions before the operation.
- Re-check on ambiguous failure to distinguish expected concurrent changes from defects.

## Multi-System Mutation Ordering

- When a multi-step operation mutates state across multiple systems, order mutations as the reverse of the observation order.
- Setup (resource creation): write the external system first, then the local DB. The resource becomes observable only once fully provisioned.
- Teardown (resource deletion): write the local DB first, then the external system. The resource becomes unobservable immediately.
- A "system" is an ownership or observation boundary, not necessarily a separate process or database.

## Recursive Boundaries

- Apply mutation ordering recursively at each boundary.
- The caller orders its own state relative to calls into the child module.
- The child module orders its own local state relative to the external systems it wraps.
- Do not reach across module boundaries to mutate another module's internal tables to force ordering.
- Do not widen a caller-owned DB transaction across module boundaries.
