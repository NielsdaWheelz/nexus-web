# codex host: compose-declared egress in the pending release

status: open · origin: 2026-10-10 cleanup/codex-egress-compose · area: release / codex host

the codex section of [the pending release](production-release-pending-since-7dc68929b.md).
production runs the codex host of `7dc68929b` (codex 0.144.4 sdk host, python
egress). the release crosses straight to the stock codex 0.160.0 app-server
behind a stock nginx sni allowlist. nothing below is a schema change; compose
recreates `codex-egress-policy` and `nexus-codex-agent-host` during `up`.

## what changes on the host (7dc68929b -> this release, read from both trees)

| | 7dc68929b | release | step |
|---|---|---|---|
| credential bind | the file `.../codex-personal/auth.json` at `/run/nexus-codex-credential/auth.json` | the directory `/srv/nexus/codex-state/codex/codex-personal` at `/var/lib/nexus-codex/codex/codex-personal`, writable | 1 |
| codex | 0.144.4 sdk, per-turn tmpfs `/run/nexus-codex-turns` | 0.160.0 app-server; its state lives in the account directory | 1, 4 |
| socket | `/run/nexus-codex/agent.sock`; volume `nexus_nexus_codex_run` root `0770` | `/tmp/codex-daemon-10001/app-server.sock`, same volume, root `0700` | 2, 5 |
| confinement | apparmor `nexus-codex-agent-host`, seccomp and systempaths unconfined | docker defaults | 6 |
| egress | python sidecar on the worker image, uid 10002, `NET_BIND_SERVICE`; dns server; chatgpt.com, `*.chatgpt.com`, auth.openai.com and the mcp host | `nginx:1.30.5-alpine@sha256:0985e772...`, uid 101, no capability; `extra_hosts`; exactly `chatgpt.com:443`, `auth.openai.com:443` | 3, 4 |
| restart, nofile | `"no"`, 64 | `on-failure:3`, 1024 | none |
| names, addresses | `codex_private` 172.30.0.0/24, proxy .2, host .3 | unchanged | none |
| luks mount, boot guard | `/srv/nexus/codex-state`, guard unit | unchanged | none |

## steps

1. before the window, read only: `sudo stat -c '%u:%g:%a %n' /srv/nexus/codex-state/codex/codex-personal /srv/nexus/codex-state/codex/codex-personal/auth.json`
   must print `10001:10001:700` and `10001:10001:600`, and
   `df -h /srv/nexus/codex-state` must leave at least 200 MiB free (codex now
   keeps its sqlite state and logs there).
2. before the window, with the old stack running (every peer is uid 10001):
   ```sh
   docker run --rm --network none --user 10001:10001 --read-only --cap-drop ALL \
     --security-opt no-new-privileges:true \
     --mount source=nexus_nexus_codex_run,target=/tmp/codex-daemon-10001 \
     alpine:3.22 chmod 0700 /tmp/codex-daemon-10001
   ```
3. the release host pulls the proxy image from docker hub by digest during `up`;
   `docker pull nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94` before the window.
4. release normally. `up` waits for the host's health: codex 0.160.0 serving on
   the auth.json 0.144.4 wrote (harness C20: a file 0.144.4's device login wrote
   is accepted; the real token is not testable before the window). if `up` fails
   on the host, the migrations have run: stop the host, retire the credential,
   re-enroll (runbook; the owner's device code), and rerun the release. the
   rerun refuses a host container whose last exit code is not 0 (`did not stop
   cleanly`): if `docker inspect -f '{{.State.ExitCode}}'
   nexus-nexus-codex-agent-host-1` is not 0 after enrolling, `docker rm` it (it
   holds no state; `up` recreates it).
5. after the release, remove the old host's stale socket:
   ```sh
   docker run --rm --network none --user 10001:10001 --read-only --cap-drop ALL \
     --security-opt no-new-privileges:true \
     --mount source=nexus_nexus_codex_run,target=/tmp/codex-daemon-10001 \
     alpine:3.22 rm -f /tmp/codex-daemon-10001/agent.sock
   ```
6. after the release, unload the retired apparmor profile:
   `sudo apparmor_parser -R /etc/apparmor.d/nexus-codex-agent-host && sudo rm /etc/apparmor.d/nexus-codex-agent-host`.

## acceptance (live, after the release)

- `release.py --check` passes.
- `docker exec nexus-nexus-codex-agent-host-1 getent hosts example.com` fails;
  `getent hosts chatgpt.com` prints `172.30.0.2`.
- `docker exec nexus-nexus-codex-agent-host-1 python -m apps.codex_agent.health`
  prints `codex 0.160.0 ready: ...`.
- one codex chat and one codex background generation complete. a needed name
  outside the allowlist fails quietly inside codex (design risk r1); if either
  fails, read codex's `logs_2.sqlite` for a resolution error before anything else.

rollback is the pending release's: re-release the previous sha with its backup.
delete this ticket when the acceptance holds.
