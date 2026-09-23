"""temporary migration rehearsal checks for 0241 against the local database."""

import json

import db

sessions = db.rows("select id, filename, input_origin from media_upload_sessions where filename = 'legacy-baseline.pdf'")
assert sessions and sessions[0]["input_origin"] == {"kind": "LocalFile"}, sessions
constraints = {r["conname"] for r in db.rows("select conname from pg_constraint where conrelid = 'media_upload_sessions'::regclass")}
assert "uq_media_upload_sessions_published_media" not in constraints, constraints
assert "uq_media_upload_sessions_published_source_attempt" not in constraints, constraints
assert "uq_media_upload_sessions_viewer_idempotency" in constraints, constraints
indexes = {r["indexname"] for r in db.rows("select indexname from pg_indexes where tablename in ('media', 'media_upload_sessions')")}
assert "ix_media_browser_capture" in indexes and "ix_media_upload_sessions_published_media" in indexes, indexes
cols = {r["column_name"]: r for r in db.rows("select column_name, is_nullable, data_type from information_schema.columns where table_name = 'media_upload_sessions'")}
assert cols["input_origin"]["is_nullable"] == "NO" and cols["input_origin"]["data_type"] == "jsonb", cols["input_origin"]
media_cols = {r["column_name"]: r for r in db.rows("select column_name, is_nullable, data_type from information_schema.columns where table_name = 'media'")}
assert media_cols["browser_capture_sha256"]["is_nullable"] == "YES", media_cols["browser_capture_sha256"]
print("migration 0241 rehearsal: backfill, dropped uniques, indexes, columns ok", json.dumps(sessions[0], default=str))
