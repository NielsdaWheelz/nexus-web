# a permanent authored conflict reads as lag

open; source rechecked at `4d29b434f` on 2026-11-11. authored sync treats every
409 as retryable (`apps/web/src/lib/authored/sync.ts`, `TRANSIENT_4XX`). a busy
row lock (`python/nexus/api/edge.py:97`) and `Noncontiguous upload`,
`Accepted command bytes changed` and `Source sequence gap`
(`python/nexus/services/authored/__init__.py:229–245`) all answer
`E_RESOURCE_CONFLICT`; only the human message distinguishes them.

a permanent refusal therefore remains `Retrying` and presents as lag instead
of exposing a failure that needs intervention. this is a source finding, not
attribution of a particular deployed sync incident.

separate retryable contention from permanent protocol refusal at the api error
contract, then project the latter as `Refused`. do not match human copy or
rewrite the immutable pending command. apply the current wire revision rule;
the retired feedback plan is not a prohibition on this repair. the current
contract is [authored writing](../modules/notes.md); presentation stays with
`apps/web/src/components/feedback`.

resolved when contention still retries, each permanent conflict reaches the
existing failure presentation, and local writing and pending bytes survive.
