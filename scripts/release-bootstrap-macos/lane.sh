#!/usr/bin/env bash
# Runs inside the Linux runner container started by release-bootstrap-macos.sh.
# Phases: preflight | sync | release. The work tree and the secrets file are
# bind-mounted at the same absolute paths as on the workstation; the lane's
# non-secret environment arrives through `docker exec -e`.
set -euo pipefail

phase="${1:?phase required: boot | preflight | sync | toolchain | release}"
work_dir="${2:?work tree path required}"
check_device=true
[ "${3:-}" = "--no-device" ] && check_device=false
env_file="${NEXUS_RELEASE_ENV_FILE:?NEXUS_RELEASE_ENV_FILE is required}"

die() { echo "lane ($phase): $*" >&2; exit 1; }

[ -f "$env_file" ] || die "secrets file is not mounted at $env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# The runner's x86_64 JDK (Rosetta): Robolectric's native runtime has no Linux
# arm64 build, and the lane's Android host unit tests depend on it.
export JAVA_HOME=/opt/java/openjdk-x64
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export HOME=/root
export TMPDIR=/tmp
export LANG=C.UTF-8
# The test kernel resolves Docker through the daemon's default socket and
# refuses caller docker configuration.
unset DOCKER_HOST DOCKER_CONTEXT
# The background worker proof addresses the root user manager.
export XDG_RUNTIME_DIR=/run/user/0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
# The kernel's runtime state (<repo>/.nexus-test) lives on the runner's state
# volume; see the sync phase.
state_dir=/var/lib/nexus-test-state

# A docker exec that arrives before systemd has moved PID 1 into init.scope is
# placed in the container's root cgroup, and while any process lives there the
# kernel refuses to enable controllers in the root's cgroup.subtree_control
# (cgroup v2's no-internal-process rule). systemd then records the failure and
# every unit below, including the user manager, ends up without controllers.
# Join PID 1's cgroup before doing anything else so this shell never blocks it.
if [ "$(cat /proc/self/cgroup)" = "0::/" ]; then
  for _ in $(seq 1 120); do
    [ -d /sys/fs/cgroup/init.scope ] && break
    sleep 0.5
  done
  echo $$ > /sys/fs/cgroup/init.scope/cgroup.procs || die "could not leave the container root cgroup"
fi

cd "$work_dir"

case "$phase" in
  boot)
    systemctl is-system-running --wait >/dev/null 2>&1 || true
    echo "systemd: $(systemctl is-system-running || true)"
    ;;

  preflight)
    systemctl is-system-running --wait >/dev/null 2>&1 || true
    # Nothing may remain in the root cgroup, and the root must delegate the
    # controllers to its subtree before any slice can.
    root_procs="$(cat /sys/fs/cgroup/cgroup.procs)"
    [ -z "$root_procs" ] || die "processes still live in the container root cgroup: $(printf '%s' "$root_procs" | tr '\n' ' ')"
    grep -qw memory /sys/fs/cgroup/cgroup.subtree_control || echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control \
      || die "could not enable the controllers in the container root cgroup"
    # The root user manager (user@0.service, Delegate=yes) must hold the memory
    # controller. systemd 252 in this container shape loses a race when it
    # creates user.slice/user-0.slice for the manager: its attempt to enable the
    # delegated controllers in their cgroup.subtree_control fails and is never
    # retried successfully (systemd-analyze dump shows the slice's enabled mask
    # empty while its members mask names memory), so the manager starts with no
    # controllers and caches that as its supported set. The kernel accepts the
    # same writes once the tree is stable: perform them, then restart the manager
    # so it starts with the controllers visible. The exact kernel probe below is
    # the authority on whether this worked.
    loginctl enable-linger root
    systemctl start user@0.service
    for slice in /sys/fs/cgroup/user.slice /sys/fs/cgroup/user.slice/user-0.slice; do
      [ -d "$slice" ] || die "$slice is absent after starting user@0.service"
      grep -qw memory "$slice/cgroup.subtree_control" || echo "+cpu +memory +pids" > "$slice/cgroup.subtree_control" \
        || die "could not enable the delegated controllers in $slice"
    done
    systemctl restart user@0.service
    manager_controllers=/sys/fs/cgroup/user.slice/user-0.slice/user@0.service/cgroup.controllers
    memory_delegated() {
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        grep -qw memory "$manager_controllers" 2>/dev/null && return 0
        sleep 1
      done
      return 1
    }
    memory_delegated || die "the memory controller is not delegated to user@0.service"
    systemctl is-active --quiet user@0.service || die "root user manager (user@0.service) is not active"
    [ -S /run/user/0/bus ] || die "root user bus is absent at /run/user/0/bus"
    systemctl is-active --quiet adb-forward.service || die "adb-forward.service is not active"

    # The exact cgroup delegate probe the test kernel runs before the background
    # worker lane (python/nexus_test_control/services.py, cgroup_delegate_failure).
    systemd-run --user --scope --quiet --collect \
      --unit="nexus-release-cgroup-delegate-$(date +%s)" \
      -p MemoryMax=1073741824 -p MemorySwapMax=0 -p OOMPolicy=continue \
      /bin/sh -c 'set -eu
        cgroup="/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)"
        test "$(cat "$cgroup/memory.max")" = "1073741824"
        test "$(cat "$cgroup/memory.oom.group")" = "0"
        grep -qw memory "$cgroup/cgroup.controllers"' \
      || die "the user-systemd cgroup delegate probe failed"
    echo "cgroup delegate: ok"

    docker info >/dev/null 2>&1 || die "the workstation docker socket is not usable from the runner"
    [ -S /var/run/docker.sock ] || die "docker socket is not mounted at /var/run/docker.sock"
    echo "docker: ok"

    for tool in java javac keytool bun uv node supabase actionlint git socat; do
      command -v "$tool" >/dev/null || die "required tool is absent: $tool"
    done
    java -version >/dev/null 2>&1 || die "the x86_64 JDK at $JAVA_HOME cannot execute; enable Rosetta in Docker Desktop (Settings > General > Use Rosetta for x86_64/amd64 emulation) and restart it"
    [ -f "$ANDROID_HOME/platform-tools/adb" ] || die "adb is absent under $ANDROID_HOME"
    ls "$ANDROID_HOME"/build-tools/*/apksigner >/dev/null 2>&1 || die "apksigner is absent under $ANDROID_HOME"
    ls "$ANDROID_HOME"/cmdline-tools/*/bin/apkanalyzer >/dev/null 2>&1 || die "apkanalyzer is absent under $ANDROID_HOME"
    echo "toolchain: ok"

    # AGP's aapt2 is an x86_64 binary; prove the workstation's Rosetta emulation
    # runs one before the lane spends anything.
    aapt2="$(ls "$ANDROID_HOME"/build-tools/*/aapt2 | tail -1)"
    "$aapt2" version >/dev/null 2>&1 || die "x86_64 aapt2 cannot execute; enable Rosetta in Docker Desktop (Settings > General > Use Rosetta for x86_64/amd64 emulation) and restart it"
    echo "x86_64 emulation (aapt2): ok"

    inventory="$(adb devices -l)" || die "adb could not reach the workstation adb server through the forwarder"
    pgrep -x adb >/dev/null && die "a local adb server is running inside the runner; only the workstation server may own the transport"
    if [ "$check_device" = true ]; then
      device_rows="$(printf '%s\n' "$inventory" | awk 'NR>1 && $2 == "device"')"
      [ "$(printf '%s\n' "$device_rows" | grep -c . || true)" = 1 ] || \
        die "exactly one authorized adb device is required through the forwarder; got: ${device_rows:-none}"
      printf '%s' "$device_rows" | grep -q "usb:" || die "the forwarded device has no usb: topology: $device_rows"
      echo "device: $device_rows"
    else
      echo "adb bridge: ok (device check skipped)"
    fi

    [ -f "$NEXUS_ANDROID_RELEASE_STORE_FILE" ] || die "keystore is not mounted at $NEXUS_ANDROID_RELEASE_STORE_FILE"
    [ -d "$(dirname "$work_dir")/llm-calling" ] && [ -d "$(dirname "$work_dir")/llm-tools" ] || \
      die "sibling suites are not mounted beside $work_dir"
    [ "$(git rev-parse HEAD)" = "$(git -C "$work_dir" rev-parse HEAD)" ] || die "git cannot read the work tree"
    echo "mounts: ok ($(git rev-parse --short HEAD))"
    ;;

  sync)
    # apps/android/gradle/gradle-daemon-jvm.properties makes Gradle run the build
    # on a JetBrains Runtime 21 it provisions itself from the repository's pinned
    # per-platform URL; the platform is that of the launching JVM, so with the
    # x86_64 JDK above Gradle provisions the x86_64 JBR. Gradle would still
    # prefer a JBR of another architecture already provisioned into the Gradle
    # cache volume, so drop those and stop it from adopting the base image's
    # arm64 JDKs through auto-detection.
    mkdir -p "$HOME/.gradle"
    printf '%s\n' \
      '# Written by scripts/release-bootstrap-macos/lane.sh: only the x86_64 JDKs the' \
      '# runner provides or provisions may run the build (Robolectric has no arm64 natives).' \
      'org.gradle.java.installations.auto-detect=false' \
      '# The work tree is a virtiofs bind mount; Gradle file-system watching fails on it.' \
      'org.gradle.vfs.watch=false' \
      > "$HOME/.gradle/gradle.properties"
    for release in "$HOME"/.gradle/jdks/*/release; do
      [ -f "$release" ] || continue
      if ! grep -qE '^OS_ARCH="(x86_64|amd64)"' "$release"; then
        jdk_dir="$(dirname "$release")"
        echo "removing provisioned JDK of another architecture: $(basename "$jdk_dir")"
        rm -rf "$jdk_dir" "$jdk_dir".reserved.lock
      fi
    done
    find "$HOME/.gradle/jdks" -maxdepth 1 -name '*aarch64*.tar.gz*' -delete 2>/dev/null || true

    # The kernel's runtime state (<repo>/.nexus-test: lifecycle flock files, run
    # ledgers, pinned suite checkouts) must live on a native Linux filesystem:
    # on the virtiofs bind mount, flock does not exclude processes that create
    # the lock file concurrently, which is exactly how the lane serializes its
    # template-database builds. Point .nexus-test at the runner's state volume.
    mkdir -p "$state_dir"
    if [ "$(readlink .nexus-test 2>/dev/null || true)" != "$state_dir" ]; then
      rm -rf .nexus-test
      ln -s "$state_dir" .nexus-test
    fi

    (cd python && uv sync --frozen --extra codex-agent --extra dev)
    (cd apps/web && bun install --frozen-lockfile)
    (cd node/ingest && bun install --frozen-lockfile)
    (cd apps/web && bunx playwright install chromium chromium-headless-shell)
    ;;

  toolchain)
    # Prove the Android toolchain on this venue with the lane's exact Gradle
    # commands (python/nexus_test_control/runner.py: android host tests and the
    # android release build) before the lane spends provider credit on them:
    # Robolectric on the emulated JDK, AGP, lint, x86_64 aapt2 under emulation,
    # the keystore and the assetlinks fingerprint check. The lane runs :app:clean
    # first, so nothing built here is reused by it.
    (cd apps/android && ./gradlew --no-daemon :app:testDebugUnitTest)
    (cd apps/android && ./gradlew --no-daemon -PnexusAndroidInstrumentationBuildType=release \
      :app:clean :app:lintRelease :app:assembleRelease :app:assembleReleaseAndroidTest)
    apk=apps/android/app/build/outputs/apk/release/app-release.apk
    [ -f "$apk" ] || die "release APK was not produced at $apk"
    apksigner="$(ls "$ANDROID_HOME"/build-tools/*/apksigner | tail -1)"
    signer="$("$apksigner" verify --verbose --print-certs "$apk" | sed -nE 's/^Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)\s*$/\1/p')"
    expected="$(printf '%s' "$NEXUS_ANDROID_RELEASE_CERT_SHA256" | tr -d ':' | tr 'A-F' 'a-f')"
    [ "$signer" = "$expected" ] || die "release APK signer $signer does not match NEXUS_ANDROID_RELEASE_CERT_SHA256 $expected"
    echo "toolchain proof: signed release APK built and verified (signer $signer)"
    ;;

  clean)
    # Tear down the kernel's local runtime so the lane initializes Postgres,
    # MinIO and Supabase together with one consistent runtime record. A stack
    # left over from an earlier attempt keeps its old published ports while a
    # fresh record allocates new ones, and the first Supabase call then fails
    # with "connection refused". Only this checkout's runtime (the compose
    # project named in its runtime record) is touched; the pinned suite
    # checkouts in the state volume are kept.
    ./scripts/test clean || echo "kernel clean reported failures; resetting this checkout's runtime state explicitly"
    project="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("compose_project", ""))' "$state_dir/runtime.json" 2>/dev/null || true)"
    if [ -n "$project" ]; then
      docker ps -aq --filter "name=$project" | xargs -r docker rm -f >/dev/null 2>&1 || true
      docker volume ls -q --filter "name=$project" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    fi
    rm -rf "$state_dir/runtime.json" "$state_dir/runtime-identity.json" "$state_dir/runs" "$state_dir/locks" "$state_dir/supabase"
    echo "runtime state reset${project:+ (compose project $project removed)}"
    ;;

  release)
    exec ./scripts/test release
    ;;

  *)
    die "unknown phase: $phase"
    ;;
esac
