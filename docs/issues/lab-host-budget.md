# lab and campaign host budget

status: partially implemented · 2026-10-21 · area: disposable verification,
campaigns, local images. checkout worker images (§2), teardown ownership (§3),
ordinary host admission (§4), web reuse with fresh data (§6), and campaign
consolidation (§1) are implemented. exclusive admission, client throttling and
calibration, operator maintenance and 8 gib/8 cpu dual-lab acceptance, and the
full-day 80% write-attribution criterion remain open.

this record is the change's specification. the repository commits no plans, so the
implementing change moves the contracts below into
[testing-standards.md](../local-rules/testing-standards.md) and deletes this file
and the item records it resolves.

shared host decisions are cited as `macbook-capacity dN`. their owner is
dev-server `docs/macbook-capacity-plan.md`. this record applies them; it does
not vary them.

## problem

on 2026-10-21, lab runs and one campaign oversubscribed the macbook (64 gib,
18 cores). the host load average reached 147-162. memory pressure was at warn,
with 30 gib held compressed. docker desktop (24 gib, all cpus) and a campaign
colima vm (12 gib, 6 cpus) ran side by side. the docker vm wrote 231 gb in 28 h.

remaining work is recorded separately:
- [lab-host-slots](lab-host-slots.md)
- [campaign-load-instrument](campaign-load-instrument.md)

## target contracts

### 1. one owned runtime (macbook-capacity d1, d5)

implemented. [disposable verification](../local-rules/testing-standards.md#disposable-verification)
owns the single lab runtime, repository browser helpers, native playwright verdicts
and temporary campaign cases/seeds. campaigns use dedicated checkouts and
`--repeat-each`; they retain no second stack or verdict wrapper.

the owner chose option (a): provider fakes are retained lab composition through
`--fake-providers`. [provider composition](../local-rules/testing-standards.md#provider-composition)
owns its explicit verified https transport, real pinned native hosts, context and
limitations. the live endpoint/extra-ca settings are supported operator
configuration, not ambient topology or a scenario-control seam.

the owner released the copied-harness gate; its executable stack/provider/browser
and case copies, installs and builds are retired. docker desktop is the sole
engine and the c3nt colima profile is gone (d1/d5). artifact outputs, readmes,
product/schema snapshots, backups and history remain; `c3rh-pg` and its data are
retained rehearsal state (d6). current external guidance points to the canonical
lab/testing contracts and the fixed d2 target (d9). client throttling remains §5
work, not part of this completed consolidation.

### 2. checkout worker image (macbook-capacity d8)

implemented. [checkout worker images](../local-rules/testing-standards.md#checkout-worker-images)
owns the dependency-hash tag, source-free target, checkout binds and retention
contract. lab, make and documented local codex overlays share one host cache
lock from image acquisition through real worker container creation; containers
pin the full image id before retention and lock release.

optional release image hygiene below was explicitly skipped. release image
source, runtime identity and configuration behavior remain intact.

release image hygiene. separate and optional; it lowers release rebuild cost
only:
- move `ARG SOURCE_SHA` from `docker/Dockerfile.backend:63` down to just before
  the revision `LABEL` (`:86`), so the runtime apt layer survives commits.
  `release-metadata` keeps its own ARG (`:38`). note that `python-builder`
  installs the project non-editable (`:19-21`), so its venv still changes with
  every python edit. moving the ARG alone does not make lab builds cacheable;
  only the checkout target does.
- stop the worker inheriting backend-runtime's api venv (`:75`). the worker
  copies its own venv over it at `:123`, which leaves a 327 mb dead layer.
  shared runtime packages move into a venv-free base that `api` and `worker`
  each extend.
- identity check: build `api` and `worker` at one sha before and after. compare:
  - `/app/runtime-identity.json` byte for byte;
  - `docker image inspect` config: labels, env, cmd, user, workdir;
  - a sorted `sha256sum` manifest of every regular file in the image filesystem.

  everything must be equal except layer structure and the worker's size, which
  should drop by about 327 mb.

### 3. teardown owns its images (macbook-capacity d8)

implemented. with §2, runs create no per-run images. the lab's cleanup verification
checks images alongside containers, volumes and networks:
`docker image ls -q --filter reference='nexus-lab-*'` must be empty, or cleanup
fails with 125. normal and recorded recovery teardown use `down --rmi local`.
the old per-run tags have been removed after operator approval and verification
of container references.

### 4. host-wide slots (macbook-capacity d3)

ordinary admission is implemented. exclusive acquisition ships with its real
`--client-throttle` consumer in §5; that cli and calibration remain deferred.

- the host has two slots: `${XDG_STATE_HOME:-~/.local/state}/nexus-lab/slots/slot-{1,2}`.
  they sit on the host filesystem, outside every checkout and every bind mount.
  `flock` does not serialize on docker desktop bind mounts (nexus claude memory
  `project_local_test_environment.md`).
- the lab holds `fcntl.flock(LOCK_EX)` on a slot for the whole invocation. the
  kernel releases it on exit or crash, so there is no stale-lock recovery and no
  saved-pid killer, consistent with `disposable_runtime.py:7-8`.
- an ordinary run takes any free slot. a throttled run (§5) takes both, in fixed
  order slot-1 then slot-2. ordinary runs never wait while holding a slot, so
  waits cannot deadlock.
- ordinary waits fail with 125 after 1800 seconds and print the holder run ids.
  the persistent slot files record run ids for diagnostics only and are never
  unlinked. child processes do not inherit their descriptors.
- the per-checkout lock (`.nexus-local/lab.lock`, `:230`) remains.
- persistent `make` development stacks are not slot holders.

### 5. load means a slow client (macbook-capacity d4)

- `./scripts/lab --client-throttle N` publishes `client_cpu_throttle: N` in the
  context and takes the whole host budget.
- a browser helper in `apps/web/scripts/lab/` attaches a cdp session to every
  page of the context, including pages opened later, and applies
  `Emulation.setCPUThrottlingRate({rate: N})`. an optional
  `Network.emulateNetworkConditions` latency is the slow-backend case.
  - worker container `cpus:` limits may join that case.
  - the api runs on the host, so no cgroup reaches it. use page latency.
- deadlines scale; choreography does not. playwright `expect`, action and
  navigation timeouts multiply by N. deliberate pauses that encode product
  timing keep wall-clock values, because product debounce timers are not cpu
  throttled. example: `N2.undo-split-keeps-unsaved-text-before-it` waits 300 ms
  inside the 1.5 s save window.
- calibration remains deferred to slice 6, after the operator resize window and
  owner approval, obtained by asking before calibration or the 20-run repeats:
  - at the base sha, the two
    [notes-redo-of-split-refused](notes-redo-of-split-refused.md) journeys must
    fail at least 5 of 20 under some N in {2, 4, 6, 8}. the burner measurements
    there were 6-10 of 20.
  - record the chosen N in testing-standards.
  - if no N reproduces, client cpu is not the operative slowness. add page
    latency and recalibrate.
- host cpu burners and host load-average criteria are not instruments. `loaded.sh`
  and `run.mjs`'s `os.loadavg()` guidance is retired now; the calibrated replacement
  remains unqualified.

### 6. evaluated options

- reuse `.next` per sha: implemented. derive ports from the slot
  index (checked free), keep the publishable key stable per checkout under
  `.nexus-local/`, and reuse the build when sha, clean `apps/web`, slot and key
  match. data stays fresh; only topology repeats.
  - runtime-injected public config would change production config to serve a
    test, which is a test-only seam. rejected.
  - [reusable web package and fresh data](../local-rules/testing-standards.md#reusable-web-package-and-fresh-data)
    owns the cache, runtime filesystem and invalidation contracts.
- lab postgres on tmpfs with `fsync=off`, `synchronous_commit=off` and
  `full_page_writes=off`: implemented.
  - it lives in a lab-only compose override that drops the named volume with
    `volumes: !reset []`.
  - it saves about 55-85 mb of writes per run and costs that much vm memory.
  - supabase's auth database stays cli-managed.
- template database: rejected. 35 migration files and about 100 mb of setup do
  not justify a cached template's lifecycle and invalidation.

## canonical contracts

[testing-standards](../local-rules/testing-standards.md#disposable-verification)
owns implemented runtime, campaign, provider, cache and retention contracts.
the readme names the public entrypoints. the remaining exclusive-admission and
slow-client contracts are §4–§5; applying and qualifying the fixed 8 gib/8 cpu
target still requires the operator window (d2/d3/d4).

## superseded guidance (macbook-capacity d9)

current guidance is retired or updated; historical notes stay historical:
- nexus claude memory `project_macos_linux_runner_recipe.md`: "the VM defaulted
  to 8 GiB" and "check Docker Desktop memory first" now cite d2's budget.
- nexus claude memory `project_android_v2_release_state.md:35`: "Docker Desktop
  was reconfigured: VM memory 24 GiB" is superseded by d2.
- `nexus-web-campaign-artifacts/2026-10-21/notes/design.md` §12 (colima `c3nt`,
  cycles through `harness-slot.sh`, "load average > 10"), `decisions.md`
  "## environment" (per-slice colima), `2026-10-18/refs/harness-changes.md:14`
  ("docker desktop is the owner's app (down) and is never launched") and the
  harness READMEs ("bases (copied, renamed, never run)").
  - these are history and are not edited.
  - a top-level `nexus-web-campaign-artifacts/README.txt` states that harness
    copies are retired and names the lab and testing-standards as the base.
  - 32 artifact notes mention colima.
- the copied `2026-10-09/harness-slot.sh` is removed; §4 owns host admission.

## from the maintenance window (macbook-capacity d6)

- old `nexus-lab-*` worker image tags have been removed after operator approval
  and verification that no container referenced them. current teardown enforces
  an empty per-run image namespace.
- candidate nexus-owned leftovers for the operator's confirmed list. preserve
  anything unconfirmed, per [dev-server-lab-build-headroom](dev-server-lab-build-headroom.md):
  - `nexus-test-*` and `nexus-pr203-runner-*` volumes;
  - the `restart=unless-stopped` stacks `supabase_*_nexus-simplify-04` and
    `supabase_*_nexus-search-cleanup-20261002`;
- `c3rh-pg` and `c3rh-pg-data` (6 gb) are retained rehearsal container/data,
  outside the removal candidates.
- after the docker resize, two ordinary lab runs must complete concurrently
  end to end at 8 gib and 8 cpus (macbook-capacity d2).

## open question: unattributed docker writes

about 150 of the 231 gb docker desktop wrote in 28 h has no named source. measure
it before claiming §2 and §6 suffice:
- host: sample the virtualization vm process's `ri_diskio_byteswritten`
  (`proc_pid_rusage`) every minute. join the samples to lab run ids from
  `.nexus-local/lab/*/` timestamps to get per-run and idle volume.
- guest, around single runs with and without a worker build:
  - sectors written from `/sys/block/vda/stat`;
  - per-process `/proc/<pid>/io` `write_bytes` for containerd, dockerd,
    buildkit and postgres.

  read both through
  `docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -- ...`.
- resolved when 80% of a day's vm writes are attributed to named sources.

## acceptance

- macbook-capacity d10, nexus targets:
  - two lab runs at different commits with unchanged dependency inputs build no
    image.
  - after `down`, `docker image ls --filter reference='nexus-lab-*'` is empty.
- three concurrent lab invocations in separate checkouts: two run and the third
  waits with the holder shown. a throttled run waits for both slots and blocks
  both others.
- the calibrated throttle reproduces the refused-redo xfail on the base sha, and
  campaigns run with no colima, no burners and no harness outside the repository.
- the release identity check in §2 is equal, if that hygiene is done.
