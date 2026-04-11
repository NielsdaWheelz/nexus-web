# Retries

## Scope

This document covers retry boundary semantics and retry policies.

## Boundaries

- A retryable error must not cross a retry boundary unchanged.
- Retry exhaustion is a defect unless the caller explicitly handles it.

## Policies

- Retry schedules follow the schedule-shape rules in [timing.md](timing.md).
- Choose the policy by the category of dependency being called, not by use case.
- Infrastructure retries (DB, cache): short budget (~30s).
- External service retries (third-party APIs): longer budget (~5min).

## Exhaustion

- Transient database failures inside the applicable retry budget are expected and retried.
- Server-side retries are bounded.
- Unbounded retry is only for client-side components whose sole job is to maintain a connection.

## Placement

- Place retry logic as close to the operation being retried as possible.
- Retry the smallest necessary unit of work.
- Do not structure retries so it is ambiguous whether a deeper layer is already retrying the same work.

## In-Memory State

- Do not mutate in-memory state across a retry boundary.
- In-memory state created outside a retry boundary and mutated inside it is not rolled back on failure.
- Create such state inside the retryable block if it must reset on each attempt.
- Otherwise, mutate it only after the retryable block returns.
