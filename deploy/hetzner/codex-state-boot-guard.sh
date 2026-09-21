#!/bin/sh
# Force the Codex credential-state underlay closed before Docker can start.
# Installed as /usr/local/sbin/nexus-codex-state-boot-guard by release.py and
# ordered before docker.service by codex-state-boot-guard.service.
set -eu
state=/srv/nexus/codex-state
if /usr/bin/mountpoint --quiet -- "$state"; then
    exit 0
fi
if [ -L "$state" ] || { [ -e "$state" ] && [ ! -d "$state" ]; }; then
    echo "refusing unsafe Codex state underlay: $state" >&2
    exit 1
fi
/usr/bin/install -d -o root -g root -m 000 -- "$state"
