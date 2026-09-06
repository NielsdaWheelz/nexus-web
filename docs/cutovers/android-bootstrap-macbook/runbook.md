# android-v0.2.14 bootstrap release from the operator's MacBook

The one-time bootstrap Android release runs the repository release lane
(`./scripts/test release`, bootstrap mode) on the operator's macOS workstation
with the dedicated handset attached over USB, then publishes the verified
stable GitHub release. GitHub-hosted runners are unavailable (billing), neither
owned Linux VM has KVM for the lane's emulator, and the lane accepts a
USB-attached physical device for the instrumentation suite — real hardware,
stronger evidence than the hosted emulator the workflow would have booted.

The production deploy gate reads only the published release's shape and
compatibility (manifest fields, APK digests, player-protocol identity against
the deploy checkout's corpus), so a lane run on operator hardware satisfies it
exactly as a hosted run would. The tag now sits on the deploy candidate itself:
`f64652e1` (`main`) plus one commit on branch `release/android-v0.2.14-tag`
that makes the offline-reading subsystem's API-34 floor visible to
`lintRelease` (nine NewApi errors; it surfaced only because this is the first
venue to run the lane's release Gradle tasks). The tag was moved off
`beb88775`, whose PR gate had failed at merge (the repository has no branch
protection) and whose service suite is broken in ways `main` fixed later; the
release-mode test APK naming fix it also needed is already on `main`. The
player-protocol corpus is therefore identical by construction, and the APK and
the web deploy come from the same commit. The one lint commit still needs to
land on `main` by pull request.

## Where the lane actually runs

The lane cannot run natively on macOS. Its background worker proof launches
under `systemd-run --user --scope -p MemoryMax=…` and the kernel probes that
cgroup v2 delegate before the journeys run
(`python/nexus_test_control/services.py`, `cgroup_delegate_failure`). macOS has
no systemd, so `scripts/release-bootstrap-macos.sh` runs the lane inside a
Linux systemd runner container on the workstation — the same shape of
container this repository's PR gates already use on this machine — built from
`scripts/release-bootstrap-macos/Dockerfile`:

- The clean work tree at the tag, the main clone's `.git` (the work tree is a
  `git worktree`), the sibling suites, the keystore directory and the secrets
  file are bind-mounted at their workstation paths, so every path the kernel
  records is the same inside and outside the runner. The Linux dependency roots (`python/.venv`, both `node_modules`, `.nexus-test`)
  are written into the bind-mounted work tree by the runner's sync (named
  volumes nested under the virtiofs bind mount vanish from the systemd
  container's mount table mid-run); only the Gradle, uv and Playwright caches
  are named volumes. Never run the macOS `uv`/`bun` in that work tree
  afterwards. The work tree path must stay within 60 bytes: the service suite
  binds Unix sockets under `test-results/runs/<run id>/` and asserts they fit
  the 108-byte `sun_path`.
- The runner talks to the workstation's Docker daemon through the mounted
  socket; the kernel's own Postgres/MinIO/Supabase containers are siblings.
- The handset stays on the workstation's adb server (the USB transport). The
  runner's arm64 adb client reaches that server over a loopback bridge
  (`adb-forward.service`, socat to `host.docker.internal:5037`) and never starts
  a server of its own, so `adb devices -l` inside the runner reports the real
  `usb:` topology the lane requires.
- Google ships AGP's `aapt2` only for x86_64 Linux, and Robolectric's native
  runtime (the Android host unit tests) has no Linux arm64 build, so every
  Gradle/JVM step runs on x86_64 under Docker Desktop's Rosetta emulation: the
  runner launches Gradle from a pinned Temurin x86_64 JDK, and Gradle then
  provisions the x86_64 JetBrains Runtime 21 that
  `apps/android/gradle/gradle-daemon-jvm.properties` pins for that platform.
  JVM outputs are architecture-neutral. The runner preflight proves the
  emulation, the cgroup delegate, the Docker socket, the toolchain and the
  forwarded device before anything is spent; `--prepare` additionally runs the
  lane's exact Gradle commands (host unit tests, `lintRelease`, the signed
  release APK and its test APK) and verifies the signer certificate.
- `./scripts/test doctor` is not part of the ceremony: on a fresh venue it
  reports `not_run` by construction (the pinned provider-runtime/llm-tools
  checkouts and the local test runtime only exist after a FULL-tier lane has
  run), and CI never runs it either. The runner preflight covers what doctor
  would have caught up front.

## One-time setup on the MacBook

1. Tooling: Docker Desktop (running, with **at least 16 GiB memory** and
   **Rosetta x86_64 emulation enabled** — Settings › Resources and
   Settings › General; the lane runs a full browser stack, Gradle and the
   service containers inside one VM), JDK 21 (`keytool` on PATH, used only to
   derive the signer certificate fingerprint), Android SDK platform-tools at
   `~/Library/Android/sdk` (or export `ANDROID_HOME`; the workstation `adb`
   server owns the handset), `gh` (authenticated). `bun` and `uv` are not needed
   on the Mac; the runner carries them.
2. Runner base image: the Dockerfile builds on the workstation's existing Linux
   systemd runner image (`nexus-pr195-test:systemd-gates2`; override with
   `--build-arg BASE_IMAGE=…`). That image is local to this machine.
3. Sibling suites: clone `llm-calling` and `llm-tools` next to this repository
   (the lane resolves them at `<repo parent>/llm-calling` and
   `<repo parent>/llm-tools`).
4. Phone: USB debugging enabled and this computer authorized; exactly one adb
   device attached; no emulator running. Keep it plugged in for the whole lane.
5. Secrets file at `~/.config/nexus-release/release.env` — start from
   `release.env.example` in this directory. The keystore values exist only with
   you (GitHub's copies are write-only); on this workstation they are the ones
   `~/.gradle/gradle.properties` already carries for
   `~/.android/keystores/nexus-release-20260521225054.jks`, whose certificate
   fingerprint is the one published in
   `apps/web/public/.well-known/assetlinks.json`. The keystore path must be
   absolute (it is bind-mounted into the runner). The provider keys copy over
   from the dev server:

   ```sh
   mkdir -p ~/.config/nexus-release && chmod 700 ~/.config/nexus-release
   cp docs/cutovers/android-bootstrap-macbook/release.env.example ~/.config/nexus-release/release.env
   ssh <dev-server> "grep -E '^(OPENAI|ANTHROPIC|GEMINI|MOONSHOT|DEEPSEEK)_API_KEY=|^NEXUS_FABLE_RETENTION_ACCEPTED_AT=' src/personal/nexus-web/deploy/env/env-prod-backend" >> ~/.config/nexus-release/release.env
   chmod 600 ~/.config/nexus-release/release.env
   # then fill in the four keystore lines
   ```

## Run

```sh
scripts/release-bootstrap-macos.sh --prepare   # optional: build, sync and prove the runner without the handset
scripts/release-bootstrap-macos.sh             # lane + publish (handset on USB)
```

The script verifies the workstation prerequisites and the one USB handset,
creates a worktree at the `android-v0.2.14` tag beside the clone, builds the
runner image, starts the runner container `nexus-release-android-v0.2.14`,
runs its preflight, syncs the three dependency roots inside it, runs the
release lane inside it (the long part: full non-browser suites, journeys,
extension, provider certification, signed APK build and verification,
instrumentation on the USB handset), and on green publishes the
draft-then-stable release with its five assets from the workstation. If the
lane passed but publishing was interrupted, rerun with `--publish-only`.

Provider certification spends real LLM API credit on each lane attempt.

To start over with a fresh runner: `docker rm -f nexus-release-android-v0.2.14`
(the named volumes `nexus-release-android-v0.2.14-*` keep the caches; remove
them too for a fully cold start). Every `docker exec` into the runner goes
through `lane.sh`, which first leaves the container's root cgroup: an exec that
stays there blocks systemd from delegating controllers to the user manager.

## After it publishes

The production deploy of `f64652e1` (the Solar) runs from the dev server —
nothing further happens on the MacBook. The operator device smoke on the real
phone follows the deploy, as the bootstrap release notes state.
