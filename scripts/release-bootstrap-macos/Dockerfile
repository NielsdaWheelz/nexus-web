# Linux runner for the one-time android-v0.2.14 bootstrap release on the
# operator's Apple-silicon workstation.
#
# The repository release lane cannot run natively on macOS: its background
# worker proof launches under `systemd-run --user --scope -p MemoryMax=...`
# (python/nexus_test_control/services.py), which needs a Linux user-systemd
# cgroup v2 delegate. This image adds the Android release toolchain to the
# workstation's existing Linux systemd runner base (the same kind of container
# the repository's PR gates already run in on this machine) so the lane runs
# unchanged, at the release tag, on a bind-mounted clean worktree.
#
# Android specifics on arm64 Linux:
#   * Google publishes AGP's aapt2 only for x86_64 Linux; Docker Desktop's
#     Rosetta emulation executes it. The runner preflight proves that before
#     anything is spent.
#   * platform-tools from Google is x86_64 too; the adb *client* here is the
#     distribution's native arm64 build (same adb protocol version 41). It
#     talks to the workstation's own adb server, where the handset is on USB,
#     through the adb-forward.service loopback bridge below.
#   * apksigner, apkanalyzer, sdkmanager, lint, R8 and Gradle are JVM tools.
#   * Robolectric's native runtime (the Android host unit tests) has no Linux
#     arm64 build, so every Gradle/JVM step of the lane runs on an x86_64 JDK
#     under the same Rosetta emulation. JVM outputs are architecture-neutral.
ARG BASE_IMAGE=nexus-pr195-test:systemd-gates2
FROM ${BASE_IMAGE}

# Eclipse Temurin JDK 21 for linux x64, pinned from api.adoptium.net.
ARG X64_JDK_URL=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz
ARG X64_JDK_SHA256=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94

# cmdline-tools;19.0 as published in Google's repository index
# (https://dl.google.com/android/repository/repository2-3.xml, SHA-1 as listed).
# 19.0 is the last release whose sdkmanager is the JVM tool; from 23.0 it is a
# native x86_64 "Android CLI" that traps under Rosetta. apkanalyzer, which the
# lane requires, is a JVM tool in every release.
ARG ANDROID_CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
ARG ANDROID_CMDLINE_TOOLS_SHA1=5fdcc763663eefb86a5b8879697aa6088b041e70
ARG ANDROID_BUILD_TOOLS=36.0.0
ARG ANDROID_PLATFORM=android-36

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/opt/java/openjdk-x64

RUN set -eux; \
    # x86_64 dynamic loader and runtime libraries for AGP's aapt2, executed by
    # the workstation's Rosetta emulation inside this arm64 rootfs.
    dpkg --add-architecture amd64; \
    apt-get update; \
    apt-get install -y --no-install-recommends adb socat unzip \
        libc6:amd64 libstdc++6:amd64 zlib1g:amd64; \
    rm -rf /var/lib/apt/lists/*; \
    # The work tree and the clone's .git are bind mounts owned by the
    # workstation user; git must still operate on them as the runner's root.
    git config --system --add safe.directory '*'; \
    # systemd-binfmt flushes every binfmt_misc registration at boot. This
    # privileged runner shares the Docker VM's global binfmt_misc instance, so
    # letting it run would unregister Docker Desktop's Rosetta handler for the
    # whole VM (every amd64 process, in every container, then fails with "exec
    # format error" until Docker Desktop restarts). The runner needs no binfmt
    # of its own; keep systemd away from that interface entirely.
    systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount

RUN set -eux; \
    mkdir -p "$JAVA_HOME"; \
    curl -fsSL -o /tmp/jdk-x64.tar.gz "$X64_JDK_URL"; \
    echo "$X64_JDK_SHA256  /tmp/jdk-x64.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jdk-x64.tar.gz -C "$JAVA_HOME" --strip-components=1; \
    rm /tmp/jdk-x64.tar.gz

RUN set -eux; \
    mkdir -p "$ANDROID_HOME/cmdline-tools" "$ANDROID_HOME/platform-tools"; \
    curl -fsSL -o /tmp/cmdline-tools.zip "$ANDROID_CMDLINE_TOOLS_URL"; \
    echo "$ANDROID_CMDLINE_TOOLS_SHA1  /tmp/cmdline-tools.zip" | sha1sum -c -; \
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools; \
    mv /tmp/cmdline-tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"; \
    rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools; \
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null; \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install \
        "platforms;$ANDROID_PLATFORM" "build-tools;$ANDROID_BUILD_TOOLS" "platform-tools" >/dev/null; \
    # The lane resolves adb at $ANDROID_HOME/platform-tools/adb. Keep Google's
    # platform-tools package (AGP wants its metadata) but replace its x86_64 adb
    # with the distribution's native arm64 client; only the client runs here.
    cp /usr/bin/adb "$ANDROID_HOME/platform-tools/adb"; \
    chmod 0755 "$ANDROID_HOME/platform-tools/adb"

# Loopback bridge to the workstation's adb server (Docker Desktop resolves
# host.docker.internal to the macOS host). Without it the container's adb
# client would start its own server, which cannot see USB.
RUN set -eux; \
    printf '%s\n' \
        '[Unit]' \
        'Description=Forward loopback adb port 5037 to the workstation adb server' \
        'After=network.target' \
        '' \
        '[Service]' \
        'ExecStart=/usr/bin/socat TCP4-LISTEN:5037,bind=127.0.0.1,reuseaddr,fork TCP4:host.docker.internal:5037' \
        'Restart=always' \
        'RestartSec=1' \
        '' \
        '[Install]' \
        'WantedBy=multi-user.target' \
        > /etc/systemd/system/adb-forward.service; \
    systemctl enable adb-forward.service; \
    # The lane's background worker needs the root user manager (user@0.service)
    # with the memory controller delegated (Delegate=yes). Declare the accounting
    # the manager and its slice need so systemd 252's masks name the controllers
    # explicitly; the runner preflight (lane.sh) then enables them in the slices,
    # which this systemd loses a race on, restarts the manager and verifies with
    # the kernel's own probe.
    mkdir -p /etc/systemd/system/user@.service.d /etc/systemd/system/user-.slice.d; \
    printf '[Service]\nMemoryAccounting=yes\nCPUAccounting=yes\nTasksAccounting=yes\n' \
        > /etc/systemd/system/user@.service.d/10-nexus-accounting.conf; \
    printf '[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nTasksAccounting=yes\n' \
        > /etc/systemd/system/user-.slice.d/10-nexus-accounting.conf

# The runner base image addresses Docker through /docker.sock; this runner
# mounts the workstation's socket at the daemon default instead, which is where
# the test kernel resolves it, and passes no caller docker configuration.
ENV DOCKER_HOST=

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
