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
5. structural alembic checks: exactly one canonical head, and no migration
   importing the `nexus` application.

keep this a fixed, explicit shell sequence. checks must be deterministic,
unprivileged, network-independent after locked dependency installation, and
cheap enough to target two minutes on the self-hosted devbox. do not add
selectors, orchestration, receipts, coverage targets, or a second gate.

`.github/workflows/ci.yml` installs locked dependencies and runs this command
for pull requests on the self-hosted linux x64 devbox. it has read-only
repository permission, a five-minute timeout, and cancels obsolete runs. public
source dependencies are fetched at their locked revisions without credentials.
the check step receives no secret and uses no application services, browsers,
devices or production systems.

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
public assets, then serves the canonical tls/http2 standalone runtime without hot reload.
build constants match the server's public key, exact loopback origin and source
sha; each server receives a fresh closed runtime environment. the existing public
web port uses https; next's private loopback upstream has no public entrypoint.
readiness verifies identity through `probe-web.mjs` using normal ca/hostname
verification and negotiated h2. readiness establishes
service health and identity; the driver owns assertions and deadlines. exit zero alone proves only
what that driver actually checked. teardown uses exact compose/auth ownership,
including `down --rmi local`; current labs create no per-run images. unrelated
images and other runs' resources neither fail cleanup nor become its targets.
incomplete owned cleanup turns success into exit 125 and retains recovery inputs.

the required private `web_tls` context contains `ca_file` and
`leaf_spki_sha256`. each run owns a fresh root and leaf; chromium trusts only
that exact leaf through its scoped spki exception. this is separate from the
readiness client's normal certificate verification; no global trust store or
`ignoreHTTPSErrors` setting changes. native browser/device profiles must establish
their own explicit trust before qualification.

setup requests use `browserRequest` in `scripts/lab/browser.ts`, preserving real
browser http2, cookies and origin checks. an about:blank page first opens the
same-origin `/robots.txt`, which runs no application or autosave. playwright's
`page.request` and `route.fetch` use an http1 node client and cannot qualify this
edge. temporary delayed-response cases may pause the actual browser response
with cdp; they must preserve the server's request, response and mutation identity.

auth teardown and recorded recovery share `python/scripts/lab_auth_cleanup.py`:
list exact `com.supabase.cli.project=<auth project>` containers in all states,
stop them gracefully, remove those ids, then remove exact labeled volumes and
networks. removals are nonforced and errors propagate. there is no daemon-wide
prune, whose admission conflicts across projects even with label filters.

native qualification may package the canonical extension/apk after context is
published, using its exact host/storage origins and frozen checkout source.
these generated artifacts must remain separate from the served standalone web
package. no next rebuild, static gate or source edits during the invocation.
the runtime admits only the canonical extension manifest's firefox callback
origin, derived before the web build; drivers still use real browser login.

write temporary integration/live cases for the intended behavior, observe red,
implement at the owning layer, reach green, review adversarially, refactor and
rerun affected checks. keep cases until final qualification, then delete them.
commit composition, provisioning, seed, browser helpers and contracts; retain no
scenario suite, fixture corpus or test-only product seams. playwright cases live
in ignored `apps/web/.nexus-lab/cases/`. caller files survive runtime teardown;
the author deletes them. logs and failure artifacts remain private and local.

campaigns use the same runtime in dedicated checkouts (macbook-capacity d5).
playwright's own runner and `--repeat-each` own verdicts and repetition. copy
scenario content
deliberately into ignored temporary cases; never copy stack, provider or browser
infrastructure. campaign artifact directories hold outputs and historical
records, with no executable harness. preserve historical product/schema snapshots
and recorded outputs when retiring a harness; source-shaped output is not a
second runtime.

use native expected-failure accounting: call `test.fail()` inside a catch only
after observing the exact known failure signature, then rethrow that failure.
a successful intermittent repeat stays a normal pass; unmatched failures
propagate unannotated. retain no verdict wrapper. each temporary case owns its
application/device reset across repeats: a fresh browser context does not reset
the database.

docker desktop is the sole lab engine (dev-server
`docs/macbook-capacity-plan.md`, d1). d2 fixes the target at 8 gib and 8 cpus,
with the existing disk limit. six full fake-provider labs must fit this allocation;
a measured capacity blocker remains unresolved and returns to the owner. do not
increase docker resources or reduce the accepted concurrency. host cpu burners and host load-average thresholds are retired;
historical burner results do not qualify client throttling. ask for owner
approval before calibration or the 20-run repeats.

### provider composition

core requires no model credentials and inherits no ambient provider configuration.
`--live-config FILE` explicitly supplies allowed api/worker provider settings as a
json object whose values are strings or null. `provider_endpoint_overrides` is a
json-encoded provider-to-https-origin map STRING, validated by the same import-light
`provider_runtime.endpoints.normalize_endpoint_overrides` used at dispatch.
`provider_ca_pem` is the actual pem certificate STRING, not a path. additional
operator certificates extend normal verified trust roots for generation and
embeddings; endpoint overrides retain each adapter's api path. ordinary live
configuration may combine with `--live-codex`. enroll its dedicated account once
with `./scripts/lab-codex enroll`; `up`, `status` and `down` own explicit installed
host administration. attachment starts an enrolled compatible stopped host or
reuses the running host; it never installs or replaces one. api reads the
loopback authenticated websocket; both workers stay in linux and use the private
shared client network. account state stays in the daemon-only volume. each run
owns a cwd root on the shared volume, removed only after worker shutdown and
observed remote session closure. shared access spans teardown; other labs and
shared resources survive. setup failure exits 125 before the driver. ordinary
live smokes during authorized implementation/verification have standing authority
after dedicated enrollment; account changes, disruptive administration and
load/calibration approvals remain explicit. credential propagation alone does
not prove model success.

`./scripts/lab --fake-providers -- COMMAND [ARG ...]` is retained lab composition,
not a scenario fixture corpus. it excludes `--live-config` and `--live-codex`.
each invocation owns a fresh ca and signed server leaf, explicit https origins,
synthetic credentials and real pinned codex hosts in separate host/linux socket
namespaces. the api stays on the host, with its own native codex host for the
catalog; both workers stay in linux and share the owned linux codex host.
normal teardown stops owned process groups and removes owned containers/private
inputs. after incomplete cleanup, the recovery note names the exact stores and
short host socket directory. manual host/private-input cleanup requires verified
shutdown of the recorded groups, never a blind saved-pid kill.

fake responses carry fixed text over responses sse/websocket; embeddings are
deterministic 256-dimensional word vectors. these establish wire/composition
behavior, not tools, structured generation or model quality. the context's
`fake_providers` is null normally, or `{origin, ca_file}` in fake mode. `/health`
is the sole fake observation endpoint: identity and request counters, with no
scenario control interface. cases and seeds remain temporary; each case owns its
assertions and reset. temporary drivers run separately from the static gate;
ci starts no services or browsers.

### host admission

labs share persistent `fcntl.flock` slots at
`${XDG_STATE_HOME:-~/.local/state}/nexus-lab/slots/slot-<number>`. the state home
must be absolute, common to participating worktrees and outside checkouts and
docker bind mounts. capacity defaults to six. the optional
`${XDG_STATE_HOME:-~/.local/state}/nexus-lab/capacity.json` is a closed object
with sole key `max_parallel_labs`, for example `{"max_parallel_labs": 6}`.
its value is an integer excluding booleans, at least one, with
`31000 + 10*n - 1 <= 65535`. unreadable or invalid
policy fails with 125 before image acquisition or services. no command-line or
environment count override exists. read policy once per invocation; change it
only after all lab invocations, waiters and owned runtimes are drained. counts
above six are configurable but unqualified.

after checkout ownership and before acquiring images or services, an ordinary
invocation takes any one free slot and holds it through teardown.
`--client-throttle N`, including `N = 1`, takes all configured lab slots in
ascending order and uses slot 1's ports. an unsuccessful exclusive attempt
releases every partial acquisition before waiting. a waiter holds no slots,
reports observed holder run ids without claiming a complete occupancy count,
and fails with 125 after 1800 seconds.
the checkout lock remains separate and is released last. interruption releases
the slot after teardown; a crash releases it through the kernel. child processes
do not inherit the descriptors. slot files persist; their run ids are diagnostic,
never ownership or permission to kill a process. polling provides capacity
admission, not fifo ordering or a reservation for an existing waiter.
kernel lock release does not establish service or resource removal; hard kills
require explicit recovery before reusing the affected checkout or ports.

### client throttling

`./scripts/lab --client-throttle N -- COMMAND [ARG ...]` accepts an integer
`N >= 1`, holds all configured lab slots, and publishes `client_cpu_throttle: N`.
ordinary runs publish null. `N = 1` is an exclusive unthrottled baseline.

campaign cases import `test` from `apps/web/scripts/lab/test.ts`. its default
`page` and awaited `newPage(context)` factory apply chromium's
`Emulation.setCPUThrottlingRate` before returning a page for its first app
navigation. use the factory for every page, including case-owned login contexts
and pages created later. provisioning's auth bootstrap is separate setup, not a
measured campaign page. uncontrolled popups invalidate a throttled test; the
fixture forces an unexpected failure even if a case has marked a separate known
failure with `test.fail()`. ordinary runs retain normal popup behavior.

playwright's overall test, expect, action and navigation defaults multiply by
`N`; explicitly chosen case deadlines must also scale. deliberate
`waitForTimeout` choreography stays in wall-clock milliseconds: product debounce
timers are not cpu throttled. this measures a slow client, not host load, model
latency or linux worker cpu limits.

the selected calibration rate is `N = 2`. its historical control is the
`61d2d1540` application with only the existing key-order-independent body
comparison from `16ee449cb`; the notes queue stays historical. this is an
explicitly synthetic control: an unrelated first-undo comparison defect must not
stand in for a refused split redo. a known refusal requires an actual split-redo
attempt, server rows `["one two"]` and the refusal copy. calibration requires at
least 5 known failures in 20 repeats of each undo/split/redo journey; fixed-source
verification requires 20 normal passes each, with no expected-failure annotation.

### reusable web package and fresh data

each lab slot fixes ten loopback ports starting at `31000 + 10*(slot-1)`;
six slots use 31000–31059, in database, storage, api, web, auth, auth database, shadow database,
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

`worker_checkout_image.py` alone builds a missing tag, directly with the docker
cli from `docker/Dockerfile.backend`'s `worker-checkout` target. consumers declare
only the shared image tag, with no compose `build:` stanza. new cache images carry
no compose project/service labels, so normal and saved `down --rmi local` retain
them. a host `fcntl.flock` at
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
no per-run images. checkout images remain shared after teardown; only their
cache owner acquires and retains them. teardown performs no host image inventory.

## retained foundation

keep the reusable runtime and static gate. retain exactly three search integration
checks, invoked manually through the existing `./scripts/lab` disposable runtime:

1. scope isolation: viewer permissions and requested scopes admit exactly the
   intended resources, including exclusions.
2. atomic replacement: search publication replacement exposes a complete old or
   new revision, never a mixture.
3. owner evidence: the strongest eligible passage and deterministic tie winner
   have literal displayed evidence and preserve canonical bodies and activation.

the single retained entry is `apps/web/scripts/lab/search.ts`, beside the existing
browser helpers: `./scripts/lab -- bun apps/web/scripts/lab/search.ts`.
use a small owned synthetic fixture and real application
writers and readers; retain no private corpus, new testing framework or test-only
product seams. these checks stay outside `./scripts/test` and ci; ci starts no
services or browsers.

all other scenario cases and their fixtures are temporary: delete them after
final qualification. retain no additional regression suite or coverage target.

historical test commands and proof checklists describe their original change;
they do not revive retired work. actual product defects and unresolved manual
verification concerns remain tracked in `docs/issues/`.
