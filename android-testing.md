# Android Authenticated Visual Testing

The one agent-facing entrypoint for a local, authenticated Android/WebView visual
check is:

```bash
./scripts/test android-visual \
  --sha "$(git rev-parse HEAD)" \
  --path /<owned-same-origin-path>
```

It runs the **current non-`main` worktree** against **one enrolled physical
device**, starts only the local services it owns, proves the app is signed in,
then captures the requested screen. Web/API changes need no APK rebuild or
deployment. It is opt-in: `android-visual` is never part of `changed`,
`confidence`, `pr`, `full`, `nightly`, or `release`.

## What the command does

1. Rejects `main`, a `--sha` other than `HEAD`, an invalid `--path`, or a
   worktree with a git operation in progress before starting anything; a dirty
   worktree is accepted and fingerprinted, never misreported as clean.
2. Acquires the workspace heavy lock without waiting — a second run is
   `NOT_RUN`, never a takeover of the first.
3. Starts or reuses the current worktree's local Supabase/API/web/storage stack
   and records their PIDs, ports, and logs.
4. Maps stable device ports to the branch's dynamic host ports:
   `device tcp:3000 → branch web`, `device tcp:8000 → branch API/stream`.
5. Uses the already-built debug APK when its native inputs are unchanged;
   rebuilds and `install -r`s (preserving app data) only when the APK is absent
   or a native input changed.
6. Uses the auth-session broker to create-or-reset the device's stable local
   account, mint the existing one-time `/auth/handoff` code, and open it on the
   device — the same handoff the production flow uses.
7. Waits until the device consumes the handoff and `/api/me` proves the expected
   device-scoped account and origin, then navigates to `--path`.
8. Captures a screenshot and logcat, writes a redacted manifest, and returns a
   falsifiable `pass` / `fail` / `not_run`.

Result and artifacts:

```text
test-results/runs/<run-id>/summary.json          # controller verdict
test-results/runs/<run-id>/android-visual.json   # redacted visual manifest
test-results/runs/<run-id>/android-visual-screen.png
test-results/runs/<run-id>/android-visual-logcat.txt
```

The manifest never contains a password, admin key, access/refresh token, handoff
code, verifier, cookie, or raw authorization header.

## Change lanes

| Change | Action |
|---|---|
| `apps/web` or API | No APK rebuild; the command reuses the debug APK. |
| Android/Kotlin, manifest, Gradle, or debug origin | The command rebuilds and reinstalls the debug APK automatically. |
| Hosted/provider integration | Out of scope; use a protected branch/preview, never `main`. |

## One-time setup

Use a dedicated debug device. Enable Developer options → Wireless debugging,
then pair once on a trusted network:

```bash
adb pair <device-ip>:<pairing-port> <pairing-code>
adb connect <device-ip>:<adb-port>
adb devices -l
```

Keep Platform Tools current. Do not use legacy unauthenticated `adb tcpip 5555`.

Every subsequent run is non-interactive. Provide the device to the command
through the environment; nothing here is committed:

```bash
export ANDROID_HOME=<android-sdk-path>
export NEXUS_DEVICE_SERIAL=<serial>   # optional when exactly one device is authorized
```

The account is a stable, per-device synthetic user in the local test namespace
(`nexus+android-visual+primary@example.invalid`). It is created on first use and
its password is reset into controller memory on every run, so
`pm clear app.nexus.android.debug` followed by the command restores the session
automatically.

## Fail-closed

The check is `not_run`, never green, when any of these is missing or unreadable:

- an authorized wireless device (via `NEXUS_DEVICE_SERIAL` or a single attached
  device);
- the Android SDK `platform-tools/adb`;
- the local Supabase/API/web stack (`docker`, `supabase`, `uv`);
- local Supabase auth for the device account.

It `fail`s (closed) on a guardrail violation (`main`, a `--sha` other than
`HEAD`, a foreign `--path`), an unconsumed or expired handoff, or an `/api/me`
account-identity mismatch.

## Security invariants

- The device receives only the existing single-use, 90-second, origin-bound
  `/auth/handoff`; `apps/web` remains the sole cookie owner and `python/nexus`
  the sole handoff-code issuer/consumer.
- `stream_base_url` resolves to the device-facing `http://127.0.0.1:8000`; a
  browser request to `localhost`, a LAN address, a preview, or production is a
  failure.
- Never reverse or expose Supabase admin ports. Never deploy `main` to test an
  uncommitted local change.

## Human diagnosis only

Manual multi-terminal/ADB sequences and Chrome `chrome://inspect` are for
enrollment and diagnosis, not an alternate test path. Debug WebView inspection
stays disabled in release.
