#!/usr/bin/env bash
# One-time bootstrap release of android-v0.2.14, run from the operator's macOS
# workstation with the dedicated handset attached over USB. Runs the repository
# release lane at the release tag and publishes the verified stable GitHub
# release that the production deploy gate requires.
#
# Prerequisites and setup: docs/cutovers/android-bootstrap-macbook/runbook.md
#
# Usage:
#   scripts/release-bootstrap-macos.sh                 # lane + publish
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
work_dir="$parent_dir/nexus-web-release-$TAG"

die() { echo "release-bootstrap: $*" >&2; exit 1; }

publish_only=false
[ "${1:-}" = "--publish-only" ] && publish_only=true

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

if [ -z "${NEXUS_ANDROID_RELEASE_CERT_SHA256:-}" ]; then
  NEXUS_ANDROID_RELEASE_CERT_SHA256="$(
    keytool -exportcert -alias "$NEXUS_ANDROID_RELEASE_KEY_ALIAS" \
      -keystore "$NEXUS_ANDROID_RELEASE_STORE_FILE" \
      -storepass "$NEXUS_ANDROID_RELEASE_STORE_PASSWORD" 2>/dev/null \
      | shasum -a 256 | awk '{print $1}'
  )"
  [ "${#NEXUS_ANDROID_RELEASE_CERT_SHA256}" = 64 ] || die "could not derive the signer certificate SHA-256 from the keystore"
fi

# --- environment the lane reads (mirrors the release workflow env block) ---
export ANDROID_RELEASE_TAG="$TAG"
export NEXUS_ANDROID_RELEASE_BASE_URL="https://nexus.nielseriknandal.com"
export NEXUS_ANDROID_RELEASE_OWNED_HOST="nexus.nielseriknandal.com"
export NEXUS_ANDROID_RELEASE_API_ORIGIN="https://api.nexus.nielseriknandal.com"
export NEXUS_GOOGLE_WEB_CLIENT_ID="638823921070-0odl37nej8h5tpuvj4vu5elj1e86gq8s.apps.googleusercontent.com"
export NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID="579543d7-64ec-4282-9f1b-7a445ebf672a"
export NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID="8d180b14-40cf-4be4-b4bb-6b509d08f50f"
export NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID="ce72f700-7416-44a5-ac80-9a2fb8d23717"
export NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID="c43fcd45-e840-4392-979d-7a3b604574a5"
export NEXUS_ANDROID_VERSION_CODE="$VERSION_CODE"
export NEXUS_ANDROID_PREVIOUS_VERSION_CODE="$PREVIOUS_VERSION_CODE"
export NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE="true"
export NEXUS_ANDROID_VERSION_NAME="${TAG#android-v}"
export NEXUS_PROVIDER_CERTIFICATION="1"
export NEXUS_ANDROID_RELEASE_CERT_SHA256
# The test kernel rejects caller docker configuration; the CLI's own current
# context (Docker Desktop / OrbStack) still applies.
unset DOCKER_HOST DOCKER_CONTEXT

# --- preflight -------------------------------------------------------------
command -v gh >/dev/null || die "gh CLI is required"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
command -v docker >/dev/null || die "docker is required (Docker Desktop or OrbStack)"
docker info >/dev/null 2>&1 || die "docker daemon is not running"
command -v uv >/dev/null || die "uv is required"
command -v bun >/dev/null || die "bun is required"
command -v keytool >/dev/null || die "keytool (JDK) is required"
[ -d "$parent_dir/llm-calling" ] || die "sibling suite missing: $parent_dir/llm-calling (git clone it next to this repo)"
[ -d "$parent_dir/llm-tools" ] || die "sibling suite missing: $parent_dir/llm-tools (git clone it next to this repo)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
adb="$ANDROID_HOME/platform-tools/adb"
[ -x "$adb" ] || die "adb not found under ANDROID_HOME=$ANDROID_HOME"

device_rows="$("$adb" devices -l | awk 'NR>1 && $2 == "device"')"
[ "$(printf '%s\n' "$device_rows" | grep -c . || true)" = 1 ] || \
  die "exactly one authorized adb device is required; got: ${device_rows:-none} (enable USB debugging, unplug everything else, stop any emulator)"
printf '%s' "$device_rows" | grep -q "usb:" || \
  die "the attached device has no usb: topology (wireless adb cannot satisfy the lane): $device_rows"
echo "device: $device_rows"

# --- checkout at the release tag ------------------------------------------
git -C "$repo_root" fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG" || true
tag_commit="$(git -C "$repo_root" rev-parse "$TAG^{commit}")" || die "tag $TAG is absent"
if [ ! -d "$work_dir" ]; then
  git -C "$repo_root" worktree add --detach "$work_dir" "$tag_commit"
fi
[ "$(git -C "$work_dir" rev-parse HEAD)" = "$tag_commit" ] || die "$work_dir is not at $TAG"

if [ "$publish_only" = false ]; then
  echo "syncing dependency roots (first run takes a while)"
  (cd "$work_dir/python" && uv sync --frozen --extra codex-agent --extra dev)
  (cd "$work_dir/apps/web" && bun install --frozen-lockfile)
  (cd "$work_dir/node/ingest" && bun install --frozen-lockfile)
  (cd "$work_dir/apps/web" && bunx playwright install chromium chromium-headless-shell)

  echo "running environment doctor"
  (cd "$work_dir" && ./scripts/test doctor) || die "doctor failed; fix what it names and rerun"

  echo "running the release lane (this is the long part)"
  (cd "$work_dir" && ./scripts/test release)
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
