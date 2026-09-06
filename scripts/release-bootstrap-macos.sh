#!/usr/bin/env bash
# One-time bootstrap release of android-v0.2.14, run from the operator's macOS
# workstation with the dedicated handset attached over USB. Runs the repository
# release lane at the release tag and publishes the verified stable GitHub
# release that the production deploy gate requires.
#
# The lane itself runs in a Linux systemd runner container on this workstation
# (scripts/release-bootstrap-macos/Dockerfile): the lane's background worker
# proof requires a Linux user-systemd cgroup delegate, which macOS cannot
# provide. The work tree, the sibling suites, the keystore and the secrets file
# are bind-mounted at their workstation paths; the handset stays on the
# workstation's adb server, which the runner reaches over a loopback bridge.
#
# Prerequisites and setup: docs/cutovers/android-bootstrap-macbook/runbook.md
#
# Usage:
#   scripts/release-bootstrap-macos.sh                 # lane + publish
#   scripts/release-bootstrap-macos.sh --prepare       # build the runner and sync dependencies only (no handset needed)
#   scripts/release-bootstrap-macos.sh --publish-only  # re-publish an existing green lane run
set -euo pipefail

TAG="android-v0.2.14"
VERSION_CODE=17
PREVIOUS_VERSION_CODE=16
REPOSITORY="NielsdaWheelz/nexus-web"
ENV_FILE="${NEXUS_RELEASE_ENV_FILE:-$HOME/.config/nexus-release/release.env}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
parent_dir="$(dirname "$repo_root")"
# Keep the work tree path short: the service suite binds Unix sockets at
# <repo root>/test-results/runs/<run id>/<6>.sock and asserts the absolute path
# fits Linux's 108-byte sun_path (python/tests/testkit/codex_metadata.py), which
# leaves 60 bytes for the repo root.
work_dir="$parent_dir/nexus-release-${TAG#android-v}"
max_work_dir_bytes=60
runner_dir="$script_dir/release-bootstrap-macos"
runner_image="nexus-release-runner:$TAG"
runner="nexus-release-$TAG"

die() { echo "release-bootstrap: $*" >&2; exit 1; }

mode=lane
case "${1:-}" in
  "") ;;
  --prepare) mode=prepare ;;
  --publish-only) mode=publish ;;
  *) die "usage: $0 [--prepare | --publish-only]" ;;
esac

# --- secrets ---------------------------------------------------------------
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (start from docs/cutovers/android-bootstrap-macbook/release.env.example)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
for name in NEXUS_ANDROID_RELEASE_STORE_FILE NEXUS_ANDROID_RELEASE_STORE_PASSWORD \
  NEXUS_ANDROID_RELEASE_KEY_ALIAS NEXUS_ANDROID_RELEASE_KEY_PASSWORD \
  OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY MOONSHOT_API_KEY DEEPSEEK_API_KEY \
  NEXUS_FABLE_RETENTION_ACCEPTED_AT; do
  [ -n "${!name:-}" ] || die "$name is required in $ENV_FILE"
done
[ -f "$NEXUS_ANDROID_RELEASE_STORE_FILE" ] || die "keystore not found at $NEXUS_ANDROID_RELEASE_STORE_FILE"
case "$NEXUS_ANDROID_RELEASE_STORE_FILE" in
  /*) ;;
  *) die "NEXUS_ANDROID_RELEASE_STORE_FILE must be an absolute path (it is bind-mounted into the runner)" ;;
esac

command -v keytool >/dev/null || die "keytool (JDK 21) is required on PATH"
if [ -z "${NEXUS_ANDROID_RELEASE_CERT_SHA256:-}" ]; then
  cert_dir="$(mktemp -d)"
  trap 'rm -rf "$cert_dir"' EXIT
  # Apple's /usr/bin/keytool stub exits non-zero with no output when no JDK is
  # installed; hashing that would still yield 64 hex characters, so require a
  # successful, non-empty export before deriving anything from it.
  keytool -exportcert -alias "$NEXUS_ANDROID_RELEASE_KEY_ALIAS" \
    -keystore "$NEXUS_ANDROID_RELEASE_STORE_FILE" \
    -storepass "$NEXUS_ANDROID_RELEASE_STORE_PASSWORD" \
    -file "$cert_dir/signer.der" >/dev/null 2>&1 \
    || die "keytool could not export the signer certificate (is a real JDK 21 keytool first on PATH?)"
  [ -s "$cert_dir/signer.der" ] || die "keytool exported an empty signer certificate"
  NEXUS_ANDROID_RELEASE_CERT_SHA256="$(shasum -a 256 "$cert_dir/signer.der" | awk '{print $1}')"
  [ "${#NEXUS_ANDROID_RELEASE_CERT_SHA256}" = 64 ] || die "could not derive the signer certificate SHA-256 from the keystore"
fi

# --- environment the lane reads (mirrors the release workflow env block) ---
# Non-secret; handed to the runner through `docker exec -e`. The secrets file
# is sourced inside the runner by scripts/release-bootstrap-macos/lane.sh.
lane_env=(
  "ANDROID_RELEASE_TAG=$TAG"
  "NEXUS_ANDROID_RELEASE_BASE_URL=https://nexus.nielseriknandal.com"
  "NEXUS_ANDROID_RELEASE_OWNED_HOST=nexus.nielseriknandal.com"
  "NEXUS_ANDROID_RELEASE_API_ORIGIN=https://api.nexus.nielseriknandal.com"
  "NEXUS_GOOGLE_WEB_CLIENT_ID=638823921070-0odl37nej8h5tpuvj4vu5elj1e86gq8s.apps.googleusercontent.com"
  "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID=579543d7-64ec-4282-9f1b-7a445ebf672a"
  "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID=8d180b14-40cf-4be4-b4bb-6b509d08f50f"
  "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID=ce72f700-7416-44a5-ac80-9a2fb8d23717"
  "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID=c43fcd45-e840-4392-979d-7a3b604574a5"
  "NEXUS_ANDROID_VERSION_CODE=$VERSION_CODE"
  "NEXUS_ANDROID_PREVIOUS_VERSION_CODE=$PREVIOUS_VERSION_CODE"
  "NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE=true"
  "NEXUS_ANDROID_VERSION_NAME=${TAG#android-v}"
  "NEXUS_PROVIDER_CERTIFICATION=1"
  "NEXUS_ANDROID_RELEASE_CERT_SHA256=$NEXUS_ANDROID_RELEASE_CERT_SHA256"
  "NEXUS_RELEASE_ENV_FILE=$ENV_FILE"
)
exec_env=()
for item in "${lane_env[@]}"; do exec_env+=(-e "$item"); done

# --- preflight -------------------------------------------------------------
command -v gh >/dev/null || die "gh CLI is required"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
command -v docker >/dev/null || die "docker is required (Docker Desktop)"
docker info >/dev/null 2>&1 || die "docker daemon is not running"
command -v keytool >/dev/null || die "keytool (JDK) is required"
[ -d "$parent_dir/llm-calling" ] || die "sibling suite missing: $parent_dir/llm-calling (git clone it next to this repo)"
[ -d "$parent_dir/llm-tools" ] || die "sibling suite missing: $parent_dir/llm-tools (git clone it next to this repo)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
adb="$ANDROID_HOME/platform-tools/adb"
[ -x "$adb" ] || die "adb not found under ANDROID_HOME=$ANDROID_HOME"

# The workstation's adb server owns the USB transport; the runner only bridges
# to it, so it must be up before the runner's client speaks to it.
"$adb" start-server >/dev/null 2>&1 || die "could not start the workstation adb server"
if [ "$mode" = lane ]; then
  device_rows="$("$adb" devices -l | awk 'NR>1 && $2 == "device"')"
  [ "$(printf '%s\n' "$device_rows" | grep -c . || true)" = 1 ] || \
    die "exactly one authorized adb device is required; got: ${device_rows:-none} (enable USB debugging, unplug everything else, stop any emulator)"
  printf '%s' "$device_rows" | grep -q "usb:" || \
    die "the attached device has no usb: topology (wireless adb cannot satisfy the lane): $device_rows"
  echo "device: $device_rows"
fi

# --- checkout at the release tag ------------------------------------------
[ "$(printf '%s' "$work_dir" | wc -c | tr -d ' ')" -le "$max_work_dir_bytes" ] || \
  die "work tree path $work_dir exceeds $max_work_dir_bytes bytes; the service suite's Unix socket paths would not fit sun_path (clone this repository under a shorter path)"
git -C "$repo_root" fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG" || true
tag_commit="$(git -C "$repo_root" rev-parse "$TAG^{commit}")" || die "tag $TAG is absent"
if [ ! -d "$work_dir" ]; then
  git -C "$repo_root" worktree add --detach "$work_dir" "$tag_commit"
fi
[ "$(git -C "$work_dir" rev-parse HEAD)" = "$tag_commit" ] || die "$work_dir is not at $TAG"

# --- Linux systemd runner --------------------------------------------------
runner_exec() { docker exec "${exec_env[@]}" "$runner" bash "$script_dir/release-bootstrap-macos/lane.sh" "$1" "$work_dir" "${@:2}"; }

if [ "$mode" != publish ]; then
  echo "building the runner image $runner_image"
  docker build --tag "$runner_image" "$runner_dir"

  if [ "$(docker container inspect --format '{{.State.Running}}' "$runner" 2>/dev/null || true)" != "true" ]; then
    docker rm -f "$runner" >/dev/null 2>&1 || true
    keystore_dir="$(dirname "$NEXUS_ANDROID_RELEASE_STORE_FILE")"
    # The Linux dependency roots (python/.venv, node_modules, .nexus-test) live
    # inside the bind-mounted work tree on purpose: named volumes nested under a
    # virtiofs bind mount silently vanish from this systemd container's mount
    # table mid-run, leaving whatever the workstation has at that path. Only the
    # non-nested caches are volumes.
    docker run --detach --name "$runner" --hostname "$runner" \
      --privileged --cgroupns=private --network host \
      --tmpfs /run --tmpfs /run/lock \
      --volume /var/run/docker.sock:/var/run/docker.sock \
      --volume "$repo_root/.git:$repo_root/.git" \
      --volume "$runner_dir:$runner_dir:ro" \
      --volume "$work_dir:$work_dir" \
      --volume "$parent_dir/llm-calling:$parent_dir/llm-calling:ro" \
      --volume "$parent_dir/llm-tools:$parent_dir/llm-tools:ro" \
      --volume "$keystore_dir:$keystore_dir:ro" \
      --volume "$ENV_FILE:$ENV_FILE:ro" \
      --volume "$runner-gradle:/root/.gradle" \
      --volume "$runner-cache:/root/.cache" \
      --volume "$runner-playwright:/ms-playwright" \
      --volume "$runner-state:/var/lib/nexus-test-state" \
      "$runner_image" >/dev/null
  fi
  runner_exec boot || die "the runner did not finish booting"

  echo "runner preflight (cgroup delegate, docker, toolchain, x86_64 emulation, forwarded device)"
  if [ "$mode" = prepare ]; then
    runner_exec preflight --no-device || die "runner preflight failed; fix what it names and rerun"
  else
    runner_exec preflight || die "runner preflight failed; fix what it names and rerun"
  fi

  echo "syncing dependency roots in the runner (first run takes a while)"
  runner_exec sync || die "dependency sync failed"

  if [ "$mode" = prepare ]; then
    echo "proving the Android release toolchain in the runner (lane build command, signer check)"
    runner_exec toolchain || die "Android release toolchain proof failed"
    echo
    echo "PREPARED: runner $runner is built, synced and toolchain-proven; attach the handset and rerun without --prepare."
    exit 0
  fi

  echo "running the release lane in the runner (this is the long part)"
  runner_exec release
fi

# --- publish the verified release ------------------------------------------
release_dirs=("$work_dir"/test-results/runs/*/release)
[ "${#release_dirs[@]}" = 1 ] && [ -d "${release_dirs[0]}" ] || \
  die "expected exactly one control-plane-owned release directory under $work_dir/test-results/runs"
release_dir="${release_dirs[0]}"
version_name="${TAG#android-v}"
for asset in "nexus-android.apk" "nexus-android.apk.sha256" \
  "nexus-android-$version_name.apk" "nexus-android-$version_name.apk.sha256" \
  "release-manifest.json"; do
  [ -f "$release_dir/$asset" ] || die "release asset missing: $release_dir/$asset"
done

notes="Signed Nexus Android APK. Provider certification, signature verification, the manifest/player-protocol contract, the pinned API origin, and the Android device suite passed before this draft was created. The signed-physical USB baseline stages were explicitly skipped (bootstrap_no_device): no published release carries offline reading, so no in-the-wild offline state exists for them to protect. This bootstrap release was verified by the repository release lane on the operator's workstation with the dedicated handset attached over USB; the operator device smoke follows the production deploy."

upload_args=()
if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  if [ "$(gh release view "$TAG" --repo "$REPOSITORY" --json isDraft --jq .isDraft)" = "true" ]; then
    upload_args+=(--clobber)
  else
    die "refusing to replace an already-published release"
  fi
else
  gh release create "$TAG" \
    --repo "$REPOSITORY" \
    --verify-tag \
    --draft \
    --title "$TAG" \
    --notes "$notes"
fi
gh release upload "$TAG" \
  --repo "$REPOSITORY" \
  "$release_dir/nexus-android.apk" \
  "$release_dir/nexus-android.apk.sha256" \
  "$release_dir/nexus-android-$version_name.apk" \
  "$release_dir/nexus-android-$version_name.apk.sha256" \
  "$release_dir/release-manifest.json" \
  ${upload_args[@]+"${upload_args[@]}"}

release_id="$(gh release view "$TAG" --repo "$REPOSITORY" --json databaseId --jq .databaseId)"
gh api --method PATCH "repos/$REPOSITORY/releases/$release_id" \
  -F draft=false \
  -F prerelease=false \
  -f make_latest=true >/dev/null

echo
echo "PUBLISHED: $TAG is the latest stable release."
echo "The production deploy gate is now satisfied; the Solar deploy can run."
