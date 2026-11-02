# a permanent authored conflict reads as lag

status: open
origin: 2026-11-01 feedback-homes L0a review
area: web / authored sync

every 409 on authored routes counts as `Retrying`, because the api answers a busy row
lock and a permanent conflict with the same `E_RESOURCE_CONFLICT`, and no field separates
them. `Noncontiguous upload`, `Accepted command bytes changed` and `Source sequence gap`
therefore retry for ever.

impact: a replica that can never upload shows a hollow `Lagging` mark and no slip, where
main said `couldn't sync`. the writer is not told that a person is needed.

evidence, by reading: `apps/web/src/lib/authored/sync.ts` `TRANSIENT_4XX`;
`python/nexus/api/edge.py:97`; `python/nexus/services/authored/__init__.py:229,240-241,245`.
only the human message differs, and matching it would make copy a contract.

blocker: a separating field is a wire change, which `docs/feedback-homes-spec.md` forbids.

resolved when: a client can tell a busy lock from a permanent conflict, and the conflict
reads `Refused`.
