# shared live codex release steps

clients and native hosts replace `NEXUS_CODEX_NATIVE_SOCKET` with
`NEXUS_CODEX_ENDPOINT=unix:///tmp/codex-daemon-10001/app-server.sock` and the
separate absolute `NEXUS_CODEX_CWD_ROOT=/tmp/codex-daemon-10001/cwds`.
production compose owns these settings; remove the old variable from operator
configuration. unix has no transport token. websocket clients require the secret
`NEXUS_CODEX_TRANSPORT_TOKEN`; the launcher receives only its sha256 verifier as
`NEXUS_CODEX_TRANSPORT_TOKEN_SHA256`.

local unix composition retires `NEXUS_LOCAL_CODEX_ACCOUNT_DIR` and its mac bind.
it enrolls a native uid/gid-10001-owned `nexus_codex_account` volume at
`/var/lib/nexus-codex`, with credential `auth.json`. existing bound account state
is neither copied nor deleted; enroll the new volume explicitly. production's
encrypted linux bind and fake providers retain unix behavior.

live labs replace `--codex-socket` with `--live-codex`. enroll the dedicated
account with `./scripts/lab-codex enroll`, then use `up` and `status` before the
first lab. the host loopback publication belongs to the existing nginx peer,
which forwards tcp unchanged to the native authenticated listener; the daemon
stays on internal networks with no directly published port. never copy personal
or production auth. a pin upgrade requires drained
labs, explicit `down`, then `up` from the qualified new checkout. no automatic
credential migration or downgrade is authorized.

resolved when deployment accepts the unix endpoint/cwd settings and local
composition uses the enrolled native volume; qualify shared websocket lifecycle
and account migration on the exact installed provider pin. real refresh remains
tracked in `codex-auth-refresh-not-qualified.md`.
