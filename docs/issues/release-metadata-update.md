# release metadata recovery

implementation is on `fix/metadata-recovery`; production activation remains a
separate release operation. the 2026-11-04 local qualification explicitly granted
no deployment or provider-account authority. do not treat source or lab proof as
production repair.

## cutover

- freshly inspect deployed source/schema/wire and paired clients. this candidate
  follows schema 0335 with migration 0336 and wire 20; verify the once-per-release
  wire rule against the actual release vector before activation.
- use the existing release owner and planned no-use window: commit/sync device
  writing, close clients, drain or explicitly settle old active generations and
  pending/retrying/running jobs, stop writers, verify the backup, then migrate.
  held commands may remain for owner repair; no old model protocol may run across
  this hard cutover. pair web, android and extension through the normal owner.
- migration 0336 removes review storage and report/search-only result fields,
  converts historical no_findings to failed/no_result at its original timestamp,
  including deleted media, and installs held/failed_executions without resetting
  attempt history or resurrecting dead rows. malformed history aborts. rollback
  requires the paired backup and binaries.
- optional public search/read failures must permit continued metadata research.
  restoring public search is outside this delivery; do not assert working search
  without actual receipts. the separate dependency remains in
  [brave-search-payment-required.md](brave-search-payment-required.md).

## reviewed data repair

freshly preflight salvatier (`d6204c4c-914a-425c-bd7b-732e48d32459`): exact html
hashes, current generation, source pins, structural paths and every retained
reference. use `python/scripts/repair_reader_html.py` through the publication owner;
canonical bytes, fragment identities/order, anchors, offsets and historical captures
must remain unchanged. changed html advances generation and rebuilds table
projections; normal index reconciliation follows. observe a mounted reader replace
its old units. keats (`49e3ad12-8db3-445d-a0f6-cd26d8a5e89a`) needs only the excerpt
adapter; unchanged html must keep its generation.

read-only production census at `2026-11-05T21:16:23Z`: the 35 metadata jobs created
18:26–18:40 utc remain 26 succeeded, nine dead, none unfinished. eight failures were
comment tails; one was the keats helper rejection. review each current target and
latest operation before admitting a normal new update. preserve historical dead
rows and diagnostics; do not blanket replay them. record superseded/deleted/already
repaired targets separately. verify exact new outcomes and current author credits
through the ordinary model/contributor owners, without manual bibliographic patches.

## closure

close after the paired production release, migration, reader repair, reviewed
nine-job disposition and real metadata/recovery observations pass independently.
source, static checks, disposable database/browser proof, native model integration
and production activation are separate facts. genuine chat continuation remains a
separate delivery; this change promises no automatic completion of interrupted chat.
