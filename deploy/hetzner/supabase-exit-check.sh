#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILES=()
CLEAN=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy/hetzner/supabase-exit-check.sh [--env-file <path> ...] [--clean]

Verifies whether Supabase is ready to remain Auth-only after DB/storage cutover.
By default this is a read-only pass/fail gate. It exits nonzero when legacy
public schema objects, public extensions/routines/types, Storage buckets, or
Storage objects remain.

Required env:
  SUPABASE_DATABASE_URL         Old Supabase Postgres URL

Optional env:
  DATABASE_URL                  Accepted for read-only checks only if it is a Supabase URL
  SUPABASE_URL                  Required only for --clean storage cleanup
  SUPABASE_SERVICE_KEY          Required only for --clean storage cleanup

Destructive mode:
  NEXUS_SUPABASE_EXIT_CONFIRM=clean-public-and-storage \
    deploy/hetzner/supabase-exit-check.sh --clean

The cleanup path drops/recreates only the public schema and empties/deletes all
Supabase Storage buckets. It does not drop or modify the auth schema.

Local tools:
  psql is required for all checks. curl is required only for --clean.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --clean)
      CLEAN=1
      shift
      ;;
    --env-file)
      [ $# -ge 2 ] || die "--env-file requires a path"
      ENV_FILES+=("$2")
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

if [ -n "${NEXUS_ENV_FILE:-}" ]; then
  ENV_FILES=("${NEXUS_ENV_FILE}" "${ENV_FILES[@]}")
fi

if ((${#ENV_FILES[@]})); then
  for env_file in "${ENV_FILES[@]}"; do
    [ -f "$env_file" ] || die "env file not found: $env_file"
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  done
fi

if [ "$CLEAN" = "1" ]; then
  [ -n "${SUPABASE_DATABASE_URL:-}" ] || die "--clean requires explicit SUPABASE_DATABASE_URL for the old Supabase database"
  DATABASE_URL_FOR_PSQL="$SUPABASE_DATABASE_URL"
else
  DATABASE_URL_FOR_PSQL="${SUPABASE_DATABASE_URL:-${DATABASE_URL:-}}"
fi
[ -n "$DATABASE_URL_FOR_PSQL" ] || die "set SUPABASE_DATABASE_URL"
case "$DATABASE_URL_FOR_PSQL" in
  postgresql+psycopg://*@postgres:5432/*|postgresql://*@postgres:5432/*)
    die "database URL points at the Hetzner Compose Postgres service; set SUPABASE_DATABASE_URL for the old Supabase database"
    ;;
esac
case "$DATABASE_URL_FOR_PSQL" in
  *@*.supabase.co:*/*|*@*.pooler.supabase.com:*/*) ;;
  *) die "SUPABASE_DATABASE_URL must point at the old Supabase database" ;;
esac
DATABASE_URL_FOR_PSQL="${DATABASE_URL_FOR_PSQL/postgresql+psycopg:\/\//postgresql:\/\/}"
command -v psql >/dev/null 2>&1 || die "psql is not installed"

psql_db() {
  psql "$DATABASE_URL_FOR_PSQL" -v ON_ERROR_STOP=1 "$@"
}

psql_scalar() {
  psql_db -X -A -t -P pager=off
}

storage_request() {
  local method="$1"
  local url="$2"
  local status

  status="$(
    curl -sS -o /dev/null -w "%{http_code}" \
      -X "$method" "$url" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json"
  )"

  case "$status" in
    200|204|404) ;;
    *) die "storage request failed with HTTP ${status}: ${method} ${url}" ;;
  esac
}

report_state() {
  echo "== Supabase Auth =="
  psql_db -X -P pager=off <<'SQL'
SELECT count(*) AS auth_user_count
FROM auth.users;
SQL

  echo
  echo "== Public Schema Objects =="
  psql_db -X -P pager=off <<'SQL'
SELECT
  c.relkind AS kind,
  n.nspname AS schema,
  c.relname AS name,
  CASE
    WHEN c.relkind IN ('r', 'p') THEN c.reltuples::bigint
    ELSE NULL
  END AS estimated_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
ORDER BY c.relkind, c.relname;
SQL

  echo
  echo "== Public Schema Extensions =="
  psql_db -X -P pager=off <<'SQL'
SELECT e.extname AS extension
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE n.nspname = 'public'
ORDER BY e.extname;
SQL

  echo
  echo "== Public Schema Routines And Types =="
  psql_db -X -P pager=off <<'SQL'
SELECT 'function' AS kind, p.proname AS name
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT
  CASE t.typtype
    WHEN 'd' THEN 'domain'
    WHEN 'e' THEN 'enum'
    ELSE 'type'
  END AS kind,
  t.typname AS name
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typtype IN ('d', 'e')
ORDER BY kind, name;
SQL

  echo
  echo "== Storage Buckets =="
  psql_db -X -P pager=off <<'SQL'
SELECT
  b.id AS bucket_id,
  b.name AS bucket_name,
  b.public,
  count(o.id) AS object_count
FROM storage.buckets b
LEFT JOIN storage.objects o ON o.bucket_id = b.id
GROUP BY b.id, b.name, b.public
ORDER BY b.id;
SQL
}

count_public_objects() {
  psql_scalar <<'SQL'
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
SQL
}

count_public_extensions() {
  psql_scalar <<'SQL'
SELECT count(*)
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE n.nspname = 'public';
SQL
}

count_public_routines_and_types() {
  psql_scalar <<'SQL'
SELECT
  (SELECT count(*)
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public')
  +
  (SELECT count(*)
   FROM pg_type t
   JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public'
     AND t.typtype IN ('d', 'e'));
SQL
}

count_storage_buckets() {
  psql_scalar <<'SQL'
SELECT count(*)
FROM storage.buckets;
SQL
}

count_storage_objects() {
  psql_scalar <<'SQL'
SELECT count(*)
FROM storage.objects;
SQL
}

storage_bucket_ids() {
  psql_scalar <<'SQL'
SELECT id
FROM storage.buckets
ORDER BY id;
SQL
}

verify_auth_only() {
  local public_objects public_extensions public_routines_and_types
  local storage_buckets storage_objects
  local failed=0

  public_objects="$(count_public_objects)"
  public_extensions="$(count_public_extensions)"
  public_routines_and_types="$(count_public_routines_and_types)"
  storage_buckets="$(count_storage_buckets)"
  storage_objects="$(count_storage_objects)"

  echo
  echo "== Auth-only Gate =="

  if [ "$public_objects" != "0" ]; then
    echo "FAIL public schema still has ${public_objects} table/view/sequence/foreign table object(s)"
    failed=1
  fi
  if [ "$public_extensions" != "0" ]; then
    echo "FAIL public schema still has ${public_extensions} extension(s)"
    failed=1
  fi
  if [ "$public_routines_and_types" != "0" ]; then
    echo "FAIL public schema still has ${public_routines_and_types} routine/type object(s)"
    failed=1
  fi
  if [ "$storage_buckets" != "0" ]; then
    echo "FAIL Supabase Storage still has ${storage_buckets} bucket(s)"
    failed=1
  fi
  if [ "$storage_objects" != "0" ]; then
    echo "FAIL Supabase Storage still has ${storage_objects} object(s)"
    failed=1
  fi

  if [ "$failed" = "0" ]; then
    echo "PASS Supabase has no legacy public schema or Storage leftovers"
    return 0
  fi

  echo "Supabase is not Auth-only yet. Review the report above; rerun with --clean only after backup/cutover is confirmed."
  return 1
}

clean_public_schema() {
  echo "Dropping and recreating public schema. auth schema is not touched."
  psql_db -X <<'SQL'
BEGIN;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
COMMIT;
SQL
}

clean_storage_buckets() {
  command -v curl >/dev/null 2>&1 || die "curl is not installed"
  [ -n "${SUPABASE_URL:-}" ] || die "SUPABASE_URL is required for storage cleanup"
  [ -n "${SUPABASE_SERVICE_KEY:-}" ] || die "SUPABASE_SERVICE_KEY is required for storage cleanup"

  local base_url="${SUPABASE_URL%/}"
  local bucket_id

  while IFS= read -r bucket_id; do
    [ -n "$bucket_id" ] || continue
    echo "Emptying Storage bucket: ${bucket_id}"
    storage_request POST "${base_url}/storage/v1/bucket/${bucket_id}/empty"

    echo "Deleting Storage bucket: ${bucket_id}"
    storage_request DELETE "${base_url}/storage/v1/bucket/${bucket_id}"
  done < <(storage_bucket_ids)
}

cd "$ROOT_DIR"

echo "Read-only preflight:"
report_state

if [ "$CLEAN" != "1" ]; then
  verify_auth_only
  exit $?
fi

[ "${NEXUS_SUPABASE_EXIT_CONFIRM:-}" = "clean-public-and-storage" ] || die "refusing cleanup; set NEXUS_SUPABASE_EXIT_CONFIRM=clean-public-and-storage"

echo
echo "Confirmed cleanup requested."
clean_storage_buckets
clean_public_schema

echo
echo "Post-cleanup verification:"
report_state
verify_auth_only
