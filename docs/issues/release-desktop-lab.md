# desktop lab transport and runtime cutover

routine static and functional verification uses the current source-rooted mac
docker desktop lab. devbox work is limited to measurements requiring its resource
environment. keep desktop at 8 gib/8 cpu and use the existing six-slot admission;
capacity blockers return to the owner rather than increasing resources.

install locked python dev/codex-agent dependencies, web dependencies, chromium,
docker compose and supabase 2.117.0; select and start docker desktop. runs own
fresh data, services and teardown. never attach the restored qualification volume
or main checkout's unrelated migration chain. use canonical pg_search 0.26.2 with
preload and 128 mib shared memory. the mac checks establish current composition;
actual populated [main conversion](release-search.md) was rehearsed separately
on the devbox.

codex clients and hosts cut over together from `NEXUS_CODEX_NATIVE_SOCKET` to
`NEXUS_CODEX_ENDPOINT`; unix endpoints include `unix://` and omit a token.
websocket clients require `NEXUS_CODEX_TRANSPORT_TOKEN`; the host receives only
its sha256 verifier. `NEXUS_CODEX_CWD_ROOT` names the explicit local cwd root.
update captured operator configuration and recreate matching clients/hosts;
there is no legacy setting arm. production account mounts retain their existing
owner; this change performs no production or account operation.

shared live lab codex administration belongs to `./scripts/lab-codex`; enroll
its dedicated account explicitly before attachment. fake-provider labs require
no real credentials. follow the canonical host runbook, never an unrelated socket
daemon or production account. explicit provider endpoint overrides and additional
ca roots apply to generation and embeddings while preserving verified trust and
request-owned cancellation/retry.

recorded desktop checks for exact retention/edit integration, fake-provider
composition, genuine embedding/cancellation and request-identity/cache controls
passed on their recorded source snapshots. owned runs retired normally. the
bounded devbox publication/browser operation passed on the earlier search
checkpoint.
the integrated `a3e6b8ee2` populated combined operation failed; current
`0a4098235` passes local static and all three retained checks, with its affected
populated operation still pending. none of these checks qualifies unrestricted workers or
the pending deployed endpoint change.

canonical `worker_checkout_image.py` owns shared image acquisition/retention;
normal teardown owns each run's processes, services, credentials and private
inputs. obsolete devbox resources were removed only after ownership/reference
checks and local evidence preservation. retain the verified backup, functional
checkpoint, current clone and current api/postgres images. no daemon-wide prune
or second cleanup framework is introduced.

resolve after the coordinated deployed endpoint cutover and its owner checks.
historical failures and explicit search acceptance deferrals remain unchanged.
