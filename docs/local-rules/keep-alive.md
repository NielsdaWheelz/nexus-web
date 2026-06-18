# Keep-Alive

## Scope

This document covers keep-alive and connection reuse policies.

## Rules

- A keep-alive policy pairs a TTL with a derived keep-alive interval of one third of that TTL.
- Keep-alive TTLs reflect shared infrastructure characteristics.
- Do not use keep-alive policies for data-retention or expiry durations.
- Data-retention and expiry durations are separate domain rules.
