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
exactly as a hosted run would. The player-protocol corpus is unchanged between
the tag (`beb88775`) and the deploy candidate (`f64652e1`); the manifest built
at the tag validates against the deploy.

## One-time setup on the MacBook

1. Tooling: Docker Desktop or OrbStack (running), JDK 21 (`keytool` on PATH),
   Android SDK at `~/Library/Android/sdk` (or export `ANDROID_HOME`) with
   platform-tools, build-tools, and cmdline-tools, `bun`, `uv`, `gh`
   (authenticated).
2. Sibling suites: clone `llm-calling` and `llm-tools` next to this repository
   (the lane resolves them at `<repo parent>/llm-calling` and
   `<repo parent>/llm-tools`).
3. Phone: USB debugging enabled and this computer authorized; exactly one adb
   device attached; no emulator running.
4. Secrets file at `~/.config/nexus-release/release.env` — start from
   `release.env.example` in this directory. The keystore values exist only with
   you (GitHub's copies are write-only). The provider keys copy over from the
   dev server:

   ```sh
   mkdir -p ~/.config/nexus-release && chmod 700 ~/.config/nexus-release
   cp docs/cutovers/android-bootstrap-macbook/release.env.example ~/.config/nexus-release/release.env
   ssh <dev-server> "grep -E '^(OPENAI|ANTHROPIC|GEMINI|MOONSHOT|DEEPSEEK)_API_KEY=|^NEXUS_FABLE_RETENTION_ACCEPTED_AT=' src/personal/nexus-web/deploy/env/env-prod-backend" >> ~/.config/nexus-release/release.env
   chmod 600 ~/.config/nexus-release/release.env
   # then fill in the four keystore lines
   ```

## Run

```sh
scripts/release-bootstrap-macos.sh
```

The script creates a worktree at the `android-v0.2.14` tag beside the clone,
syncs the three dependency roots, runs `./scripts/test doctor` (it names
anything missing), runs the release lane (the long part: full non-browser
suites, journeys, extension, provider certification, signed APK build and
verification, instrumentation on the USB handset), and on green publishes the
draft-then-stable release with its five assets. If the lane passed but
publishing was interrupted, rerun with `--publish-only`.

Provider certification spends real LLM API credit on each lane attempt.

## After it publishes

The production deploy of `f64652e1` (the Solar) runs from the dev server —
nothing further happens on the MacBook. The operator device smoke on the real
phone follows the deploy, as the bootstrap release notes state.
