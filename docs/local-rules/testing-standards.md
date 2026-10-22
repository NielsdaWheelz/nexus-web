# verification

this is the authoritative repository-local verification contract. it overrides
conflicting test requirements in shared rules, older cutover plans, and module
docs. the 2026-09-17 reset removes every automated test and its supporting
fixtures, harnesses, dependencies, and test-only production seams. there is no
survivor suite or obligation to reconstruct one. synthetic deployment auth
smoke and capacity canaries are removed too; runtime health, readiness,
identity, resource limits, and migration backup checks remain deployment
invariants.

## automated checks

`./scripts/test` is the sole automated verification command. it takes no
arguments and runs from any directory in the checkout. its name is retained,
but it runs static checks only:

1. `actionlint` over tracked workflows and `shellcheck` over tracked shell;
2. ruff formatting and linting over python owners;
3. pyright over the whole `nexus` package and explicit runtime entrypoints;
4. css-token lint, freshness of the generated wire types, browser tool contract
   ([typed-wire.md](typed-wire.md)) and shared citation-parser bundle, eslint, and
   typescript checking for the web app; and
5. a structural alembic check requiring exactly one canonical head.

keep this a fixed, explicit shell sequence. checks must be deterministic,
unprivileged, network-independent after locked dependency installation, and
cheap enough to target two minutes on the self-hosted devbox. do not add
selectors, orchestration, receipts, coverage targets, or a second gate.

`.github/workflows/ci.yml` installs locked dependencies and runs this command
for pull requests on the self-hosted linux x64 devbox. it has read-only
repository permission, a five-minute timeout, and cancels obsolete runs. locked
dependencies are fetched without application credentials, including the public
universal-memory git dependency. the check step receives no secret and uses no
application services, browsers, devices or production systems.

passing establishes static consistency, not working user journeys or migration
safety. production migration safety remains owned by the deployment controller:
ancestry preflight, stopped writers, a verified backup or explicit durable
operator waiver when migration is pending, and exact-head verification.

## manual verification

manually check affected behavior when the change warrants it. choose checks
from the concrete failure risk and recovery cost; pay particular attention to
durable data, destructive operations, authorization, and cross-process behavior.
record what was actually observed and any material limits. a documentation or
test-deletion change does not require replaying unrelated product journeys.

## disposable verification

`./scripts/lab -- COMMAND [ARG ...]` creates a fresh real local application,
passes an absolute private `NEXUS_LAB_CONTEXT` json path to the driver, and removes
its owned services and data afterward. it requires a dedicated checkout with
installed locked dependencies and chromium; no dotenv files, ordinary web server,
static gate or application edits during an invocation. see `./scripts/lab --help`.
the lab builds or reuses the canonical web production package, including its
public assets, then serves a private standalone runtime without hot reload.
build constants match the server's public key, exact loopback origin and source
sha; each server receives a fresh closed runtime environment. readiness establishes
service health and identity; the driver owns assertions and deadlines. exit zero alone proves only
what that driver actually checked. teardown removes generated worker images with
`down --rmi local`. cleanup checks the host-wide `nexus-lab-*` image namespace;
any remaining image makes an otherwise successful run exit 125 and retains its
private recovery inputs. current checkout runs create no per-run images.

auth teardown and recorded recovery share `python/scripts/lab_auth_cleanup.py`:
list exact `com.supabase.cli.project=<auth project>` containers in all states,
stop them gracefully, remove those ids, then remove exact labeled volumes and
networks. removals are nonforced and errors propagate. there is no daemon-wide
prune, whose admission conflicts across projects even with label filters.

write temporary integration/live cases for the intended behavior, observe red,
implement at the owning layer, reach green, review adversarially, refactor and
rerun affected checks. keep cases until final qualification, then delete them.
commit composition, provisioning, seed, browser helpers and contracts; retain no
scenario suite, fixture corpus or test-only product seams. playwright cases live
in ignored `apps/web/.nexus-lab/cases/`. caller files survive runtime teardown;
the author deletes them. logs and failure artifacts remain private and local.

`--live-config FILE` explicitly supplies allowed provider settings to api/workers;
core inherits no ambient provider configuration. credential propagation does not
prove a successful model journey. temporary drivers run separately from the static
gate; CI starts no services or browsers.

### host admission

ordinary labs share two host slots at
`${XDG_STATE_HOME:-~/.local/state}/nexus-lab/slots/slot-{1,2}`. the state home must
be absolute and outside checkouts and docker bind mounts. after checkout
ownership and before acquiring images or services, each invocation takes any
free `fcntl.flock` slot and holds it through teardown. a waiter holds neither
slot, reports the recorded holder run ids, and fails with 125 after 1800 seconds.
the checkout lock remains separate and is released last. interruption releases
the slot after teardown; a crash releases it through the kernel. child processes
do not inherit the descriptors. slot files persist; their run ids are diagnostic,
never ownership or permission to kill a process. throttled exclusive admission
and campaign convergence remain pending in [lab-host-slots](../issues/lab-host-slots.md).

### reusable web package and fresh data

each host slot fixes ten loopback ports: slot 1 uses 31000–31009 and slot 2 uses
31010–31019, in database, storage, api, web, auth, auth database, shadow database,
mail, smtp and pop3 order. all ten are checked together before acquiring images
or services. an occupied port fails the invocation; there is no alternate-port
selection. the slot remains held through teardown.

`.nexus-local/publishable-key` holds only the checkout's stable public auth key.
private keys, privileged credentials, readers, database and storage data remain
fresh for every invocation. auth's topology stays owned by the Supabase CLI.

one completed package per checkout is reusable when source sha, slot and public
key match `.nexus-local/web-build.json` and `apps/web` has no staged, unstaged or
nonignored untracked changes. dirty web source always builds and never publishes
a marker. every rebuild removes the previous marker first. publication follows
successful canonical build/packaging, matching root and standalone build ids,
required packaged files and an unchanged post-build source sha and web status.
the marker records that build id, so another build cannot silently replace its
artifact. regenerated `.next/types` is neither proof nor invalidation of a build.

the canonical standalone package is never the writable runtime. each run copies
its entry, manifests and server tree under private inputs, linking only its
immutable `node_modules`, `public` and `.next/static` directories. `.next/cache`
is not copied. the copied entry establishes its own directory; fetch, image and
ISR writes stay in that run's tree and follow its private-input cleanup. build
and serving retain normal production configuration and process ownership.

`docker/docker-compose.lab.yml` applies only to the disposable compose model,
shared by image preparation, runtime and recorded recovery. it resets postgres's
inherited volume mount and places pg15 data at `/var/lib/postgresql/data` on
tmpfs, with `fsync`, `synchronous_commit` and `full_page_writes` off. storage keeps
its named volume; Supabase's auth database remains separately CLI-managed.

### checkout worker images

lab and `make worker-*` share `python/scripts/worker_checkout_image.py`. the tag
is `nexus-worker-checkout:<first 16 hex of sha256>` over framed file names and
contents: `docker/Dockerfile.backend`, `docker/codex-requirements.toml`,
`python/pyproject.toml`, `python/uv.lock`, `python/README.md`,
`node/ingest/package.json` and `node/ingest/bun.lock` when present. missing and
empty lock files differ. application edits and the git sha do not change it.
the `worker-checkout` target installs dependencies only: no application source,
migrations, installed nexus project, source sha or runtime identity. checkout
source and per-run identity are read-only binds.

the owner builds only a missing tag. a host `fcntl.flock` at
`${XDG_STATE_HOME:-~/.local/state}/nexus-lab/worker-image.lock` serializes image
acquisition through `compose up --no-start --no-deps --no-build`. the real
containers pin their image before lock release, so later `up --no-build` uses
the same composition. waits log the holder's compose project and fail after
1320 seconds. the cold build itself is bounded to 1200 seconds; lock acquisition
can time out while another caller finishes its build, creation or retention.
the kernel releases the lock on exit or crash. the lock stays outside checkouts
and docker bind mounts.

under that lock the owner removes only other `nexus-worker-checkout:*` tags whose
full image ids no container references. this includes stopped containers and
references through other tag aliases; unowned tags stay intact. lab runs create
no per-run images. checkout images remain shared after teardown; generated
`nexus-lab-*` image cleanup and verification remain teardown responsibilities.

## retained foundation

keep the reusable runtime and static gate. scenario cases and their fixtures are
temporary: delete them after final qualification. retain no regression suite,
coverage target or test-only application seam.

historical test commands and proof checklists describe their original change;
they do not revive retired work. actual product defects and unresolved manual
verification concerns remain tracked in `docs/issues/`.
