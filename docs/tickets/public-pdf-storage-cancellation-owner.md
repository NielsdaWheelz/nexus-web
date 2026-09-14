status: open; source evidence, no executed reproduction
origin: 2026-09-14 peer review of publication asset streaming proposal
area: public PDF storage response ownership

`python/nexus/api/routes/public_resource_shares.py:18` uses an ordinary router;
its `/file` response at 181 therefore lacks the admitted route's outer task
shield. the proposed shared storage response cannot assume that owner exists.
installed Uvicorn `server.py:289` cancels request tasks directly after its
shutdown grace expires. AnyIO's synchronous-worker cancel scope does not shield
raw task cancellation: a pending storage `next()` can still execute after the
await unwinds, so immediate generator close can race it.

attach the existing package-transfer admission to this one file route if its
current pool and deadline own this workload. preserve the public error headers,
access checks and range semantics. keep any source/proof option outside main
until reviewed. do not add a worker registry or treat an AnyIO shield as
protection from Task.cancel.

acceptance: the actual public PDF route, a held SDK read, and caller cancellation
prove physical next completion precedes exactly-once SDK close. preserve access,
range, headers and ordinary disconnect behavior. no behavior claim from this audit.
