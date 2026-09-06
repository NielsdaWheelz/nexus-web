# BASE provisioning can take the candidate runtime's recorded ports

**Status:** open
**Origin:** PR #203 takeover, 2026-09-06 (five failed `pr` attempts before the
cause was found)
**Area:** `python/nexus_test_control` (sensitivity BASE method, runtime
provisioning, failure reporting)

## Symptom

`./scripts/test pr` with `NEXUS_TEST_BASE_SHA=<main>` fails inside its first
sensitivity execution with

```
local test runtime preparation failed: Command '('docker', 'compose',
'--project-name', 'nexus-test-<candidate repo id>', '--file', '.../docker/docker-compose.test.yml',
'up', '--detach', '--wait')' returned non-zero exit status 1.
```

The candidate's Postgres and MinIO containers are left in the `Created`
state. The controller's detail names only the compose command; the docker
stderr is not persisted anywhere.

## Cause

The BASE method provisions a base checkout under the container's `/tmp`
(`/tmp/nexus-sensitivity-<random>/checkout`) with its own compose project
(`nexus-test-<random repo id>`) and allocates that project's loopback ports by
availability. If the candidate worktree's runtime stack is not running at that
moment, BASE takes the candidate's recorded ports (the runtime record pins
them: postgres 15432, minio 19000, external 19091, provider_openai 19092,
provider_api 19093, ...). When the candidate's own stack is brought up
afterwards, Docker refuses the bind. Captured with a PATH shim around the
docker CLI:

```
Error response from daemon: failed to set up container networking: driver
failed programming external connectivity on endpoint
nexus-test-21d4302262991123-minio-1 (...): Bind for 127.0.0.1:19000 failed:
port is already allocated
```

It only appears after the candidate stack has been torn down (a `clean`, an
interrupted run, or a manual `docker compose down`); the hosted runner never
hits it because the candidate runtime always comes up first there.

A second, related trap: `docker compose up` run by hand (without the
controller's environment) recreates the stack with no published ports, which
does not reserve them either.

## Proposed fix

1. When allocating ports for a BASE (or any non-candidate) runtime, exclude the
   candidate repository's recorded ports from `runtime.json`, not only the
   ports currently bound.
2. Persist the compose command's stderr in the capability detail (or a run log)
   when runtime preparation fails; the current detail hides the cause.
3. Optional: in `pr`, bring the candidate runtime up before provisioning BASE,
   which also removes the race for other loopback consumers.

## Workaround (documented in the local test-environment notes)

Start the candidate stack through the controller (any small governed
`changed <service proof>`) and start `pr` while it is running. Never
`docker compose up` the stack by hand.

## Related controller facts found in the same session

- `./scripts/test clean` reports "owned run cleanup failed" for a run whose
  template database is already gone; the run id stays in `runtime.json`
  `owned_run_ids` (the takeover worktree still lists `3739a01686797cd0`).
  `clean` should release a stale owned run when its database no longer exists.

- Local `pr` selects changed proofs against `HEAD^` unless
  `NEXUS_TEST_BASE_SHA` is set; hosted CI sets it to `main`. Without it the
  sensitivity capability reports "0 materially changed proofs" and the run is
  not equivalent to the hosted gate.
- `pr`'s complete service scope includes
  `test_control_runtime_lifecycle.py::test_template_build_clone_and_incomplete_drop_serialize_on_real_postgres`,
  which fails on a Docker Desktop bind mount because `flock(2)` does not
  serialize there; pointing `<repo>/.nexus-test/locks` at a container-native
  path restores real flock semantics.
- A container-native clone cannot run `service`+ lanes: the Supabase CLI
  bind-mounts `<repo>/.nexus-test/supabase/...` through the host daemon, which
  refuses paths not shared from the host.

## Acceptance

- A `pr` started with the candidate stack down provisions BASE on ports that
  do not collide with the candidate's recorded ports and passes runtime
  preparation.
- A failed compose `up` reports the docker stderr in the capability detail.
