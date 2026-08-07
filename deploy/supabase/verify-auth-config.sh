#!/usr/bin/env bash
set -euo pipefail

management_access_token="${SUPABASE_MANAGEMENT_ACCESS_TOKEN:-}"
unset SUPABASE_MANAGEMENT_ACCESS_TOKEN

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILES=()
PROJECT_REF=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy/supabase/verify-auth-config.sh [--env-file <path> ...]
       [--frontend-env-file <path>] [--project-ref <ref>]

Read-only Supabase hosted Auth configuration verification. Requires
SUPABASE_MANAGEMENT_ACCESS_TOKEN in the operator/CI environment. The token is
never read from synced runtime env files.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file|--frontend-env-file)
      [ $# -ge 2 ] || die "$1 requires a path"
      ENV_FILES+=("$2")
      shift 2
      ;;
    --project-ref)
      [ $# -ge 2 ] || die "--project-ref requires a value"
      PROJECT_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
[ -n "$management_access_token" ] || die "set SUPABASE_MANAGEMENT_ACCESS_TOKEN in the operator environment"
[[ "$management_access_token" =~ ^[A-Za-z0-9._-]+$ ]] || die "SUPABASE_MANAGEMENT_ACCESS_TOKEN has an invalid format"

if [ "${#ENV_FILES[@]}" -eq 0 ]; then
  ENV_FILES=("${ROOT_DIR}/deploy/env/env-prod" "${ROOT_DIR}/deploy/env/env-prod-frontend")
fi

for file in "${ENV_FILES[@]}"; do
  [ -f "$file" ] || die "missing env file: $file"
done

umask 077
tmp_env="$(mktemp)"
tmp_config="$(mktemp)"
tmp_third_party_auth="$(mktemp)"
tmp_auth_header="$(mktemp)"
trap 'rm -f "$tmp_env" "$tmp_config" "$tmp_third_party_auth" "$tmp_auth_header"' EXIT
printf 'Authorization: Bearer %s\n' "$management_access_token" >"$tmp_auth_header"
unset management_access_token

for file in "${ENV_FILES[@]}"; do
  cat "$file" >>"$tmp_env"
  echo >>"$tmp_env"
done

resolved_project_ref="$(
  PROJECT_REF="$PROJECT_REF" python3 - "$tmp_env" <<'PY'
import os
import sys
from urllib.parse import urlparse

env: dict[str, str] = {}
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        continue
    key, value = stripped.split("=", 1)
    env[key.strip()] = value.strip().strip("\"'")

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)

def require_origin(name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        fail(f"{name} is required")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        fail(f"{name} must be an HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"

def optional_smoke_origin(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        fail(f"{name} must be an HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc.lower()}"

app_origin = require_origin("APP_PUBLIC_URL")
supabase_origin = require_origin("NEXT_PUBLIC_SUPABASE_URL")
api_origin = require_origin("FASTAPI_BASE_URL")
smoke_targets = (
    ("NEXUS_SMOKE_APP_URL", app_origin),
    ("NEXUS_SMOKE_API_URL", api_origin),
    ("NEXUS_SMOKE_SUPABASE_URL", supabase_origin),
)
for name, expected in smoke_targets:
    actual = optional_smoke_origin(name)
    if actual is not None and actual != expected:
        fail(f"{name} does not match the verified production env")
host = urlparse(supabase_origin).hostname or ""
derived_ref = host.removesuffix(".supabase.co")
project_ref = os.environ.get("PROJECT_REF") or derived_ref
if not project_ref or "." in project_ref or "/" in project_ref:
    fail("Supabase project ref could not be derived; pass --project-ref")
if host != f"{project_ref}.supabase.co":
    fail("NEXT_PUBLIC_SUPABASE_URL does not match the Supabase project ref")

issuer = env.get("SUPABASE_ISSUER", "").strip()
jwks = env.get("SUPABASE_JWKS_URL", "").strip()
audiences = {part.strip() for part in env.get("SUPABASE_AUDIENCES", "").split(",")}
if issuer != f"{supabase_origin}/auth/v1":
    fail("SUPABASE_ISSUER does not match NEXT_PUBLIC_SUPABASE_URL")
if jwks != f"{supabase_origin}/auth/v1/.well-known/jwks.json":
    fail("SUPABASE_JWKS_URL does not match NEXT_PUBLIC_SUPABASE_URL")
if "authenticated" not in audiences:
    fail("SUPABASE_AUDIENCES must include authenticated")

origins: list[str] = []
for raw in env.get("AUTH_ALLOWED_REDIRECT_ORIGINS", "").split(","):
    value = raw.strip()
    if not value:
        continue
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        fail("AUTH_ALLOWED_REDIRECT_ORIGINS must contain only HTTPS origins")
    origin = f"{parsed.scheme}://{parsed.netloc.lower()}"
    if origin not in origins:
        origins.append(origin)

if not origins:
    fail("AUTH_ALLOWED_REDIRECT_ORIGINS is required")
if app_origin not in origins:
    fail("APP_PUBLIC_URL must be included in AUTH_ALLOWED_REDIRECT_ORIGINS")

print(project_ref)
for expected in [app_origin, *origins]:
    print(expected)
PY
)"

project_ref="$(printf '%s\n' "$resolved_project_ref" | sed -n '1p')"
app_origin="$(printf '%s\n' "$resolved_project_ref" | sed -n '2p')"
expected_origins="$(printf '%s\n' "$resolved_project_ref" | sed '1d' | awk 'NF' | sort -u)"

env -u SUPABASE_MANAGEMENT_ACCESS_TOKEN curl -fsS \
  -H "@${tmp_auth_header}" \
  "https://api.supabase.com/v1/projects/${project_ref}/config/auth" \
  -o "$tmp_config" || die "could not read Supabase Auth config"
env -u SUPABASE_MANAGEMENT_ACCESS_TOKEN curl -fsS \
  -H "@${tmp_auth_header}" \
  "https://api.supabase.com/v1/projects/${project_ref}/config/auth/third-party-auth" \
  -o "$tmp_third_party_auth" || die "could not read Supabase third-party Auth integrations"

APP_ORIGIN="$app_origin" \
EXPECTED_ORIGINS="$expected_origins" \
INVITE_TEMPLATE_PATH="${ROOT_DIR}/supabase/templates/invite.html" \
RECOVERY_TEMPLATE_PATH="${ROOT_DIR}/supabase/templates/recovery.html" \
python3 - "$tmp_config" "$tmp_third_party_auth" <<'PY'
import json
import os
import sys
from urllib.parse import urlparse

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    fail("Supabase Auth config response was not readable JSON")

if not isinstance(config, dict):
    fail("Supabase Auth config response was not an object")

try:
    with open(sys.argv[2], encoding="utf-8") as handle:
        third_party_auth = json.load(handle)
except Exception:
    fail("Supabase third-party Auth integration response was not readable JSON")

if not isinstance(third_party_auth, list):
    fail("Supabase third-party Auth integration response was not an array")
if third_party_auth:
    fail("Supabase third-party Auth integrations must be empty")

def require_bool(name: str, expected: bool) -> None:
    if config.get(name) is not expected:
        fail(f"Supabase Auth {name} must be {str(expected).lower()}")

def require_nonempty(name: str) -> str:
    value = config.get(name)
    if not isinstance(value, str) or not value.strip():
        fail(f"Supabase Auth {name} must be configured")
    return value

require_bool("disable_signup", True)
require_bool("external_anonymous_users_enabled", False)
require_bool("external_email_enabled", True)
require_bool("external_github_enabled", True)
require_bool("external_google_enabled", True)
require_bool("external_phone_enabled", False)
require_bool("custom_oauth_enabled", False)
require_bool("mailer_autoconfirm", False)
require_bool("mailer_allow_unverified_email_sign_ins", False)
require_bool("mailer_notifications_password_changed_enabled", True)
require_bool("passkey_enabled", False)
require_bool("password_hibp_enabled", False)
require_bool("saml_enabled", False)
require_bool("security_captcha_enabled", False)
require_bool("security_manual_linking_enabled", True)
require_bool("security_update_password_require_reauthentication", False)
require_bool("refresh_token_rotation_enabled", True)
require_bool("hook_after_user_created_enabled", False)
require_bool("hook_before_user_created_enabled", False)
require_bool("hook_custom_access_token_enabled", False)
require_bool("hook_mfa_verification_attempt_enabled", False)
require_bool("hook_password_verification_attempt_enabled", False)
require_bool("hook_send_email_enabled", False)
require_bool("hook_send_sms_enabled", False)

enabled_provider_keys = {
    name
    for name, value in config.items()
    if name.startswith("external_") and name.endswith("_enabled") and value is True
}
expected_provider_keys = {
    "external_email_enabled",
    "external_github_enabled",
    "external_google_enabled",
}
unexpected_provider_keys = sorted(enabled_provider_keys - expected_provider_keys)
if unexpected_provider_keys:
    fail(
        "Supabase Auth has an unexpected enabled provider: "
        + ", ".join(unexpected_provider_keys)
    )

enabled_hook_keys = sorted(
    name
    for name, value in config.items()
    if name.startswith("hook_") and name.endswith("_enabled") and value is True
)
if enabled_hook_keys:
    fail(
        "Supabase Auth has an unexpected enabled hook: "
        + ", ".join(enabled_hook_keys)
    )

if config.get("password_min_length") != 15:
    fail("Supabase Auth password_min_length must be exactly 15")
if config.get("password_required_characters") not in (None, ""):
    fail("Supabase Auth password_required_characters must be empty")
if config.get("refresh_token_reuse_interval") != 10:
    fail("Supabase Auth refresh_token_reuse_interval must be exactly 10")

require_nonempty("smtp_admin_email")
require_nonempty("smtp_host")
require_nonempty("smtp_pass")
require_nonempty("smtp_sender_name")
require_nonempty("smtp_user")
if str(config.get("smtp_port") or "").strip() in ("", "0"):
    fail("Supabase Auth smtp_port must be configured")

if require_nonempty("mailer_subjects_invite") != "You're invited to Nexus":
    fail("Supabase Auth invitation subject does not match the Nexus template")
if require_nonempty("mailer_subjects_recovery") != "Reset your Nexus password":
    fail("Supabase Auth recovery subject does not match the Nexus template")

invite_template = require_nonempty("mailer_templates_invite_content")
recovery_template = require_nonempty("mailer_templates_recovery_content")

def normalized_template(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")

def canonical_template(environment_name: str) -> str:
    path = os.environ[environment_name]
    try:
        with open(path, encoding="utf-8") as handle:
            return normalized_template(handle.read())
    except OSError:
        fail(f"canonical Auth template is unavailable: {environment_name}")

if normalized_template(invite_template) != canonical_template("INVITE_TEMPLATE_PATH"):
    fail("Supabase Auth invitation template does not match the canonical Nexus asset")
if normalized_template(recovery_template) != canonical_template("RECOVERY_TEMPLATE_PATH"):
    fail("Supabase Auth recovery template does not match the canonical Nexus asset")

site_url = str(config.get("site_url") or "")
raw_allow_list = config.get("uri_allow_list")
if isinstance(raw_allow_list, str):
    redirect_urls = [item.strip() for item in raw_allow_list.split(",") if item.strip()]
elif isinstance(raw_allow_list, list):
    redirect_urls = [str(item).strip() for item in raw_allow_list if str(item).strip()]
else:
    fail("Supabase Auth config did not include uri_allow_list")

origins = [line for line in os.environ["EXPECTED_ORIGINS"].splitlines() if line]
app_origin = os.environ["APP_ORIGIN"]
if site_url != app_origin:
    fail("Supabase Auth site_url does not match APP_PUBLIC_URL")

configured = set(redirect_urls)
expected = {f"{origin}/auth/callback" for origin in origins}
if configured != expected or len(redirect_urls) != len(configured):
    fail("Supabase Auth redirect allowlist must contain exactly the configured app callbacks")

for redirect_url in configured:
    parsed = urlparse(redirect_url)
    if (
        "*" in redirect_url
        or parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.path != "/auth/callback"
        or parsed.query
        or parsed.fragment
    ):
        fail("Supabase Auth production callback redirects must be exact HTTPS URLs")

print("PASS Supabase Auth configuration matches the closed-membership contract")
PY
