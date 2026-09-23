"""temporary database/storage helpers for the firefox capture v1 journeys."""

from __future__ import annotations

import json
import os
import uuid

import boto3
import psycopg
from botocore.config import Config

DATABASE_URL = os.environ.get("HARNESS_DATABASE_URL", "postgresql://postgres:postgres@localhost:54320/postgres")
USER_ID = os.environ.get("HARNESS_USER_ID", "d996e991-2dcd-4c04-b52e-6bc569359321")


def connect():
    return psycopg.connect(DATABASE_URL, autocommit=True)


def storage():
    return boto3.client(
        "s3",
        endpoint_url="http://127.0.0.1:9000",
        aws_access_key_id="nexus-local-access-key",
        aws_secret_access_key="nexus-local-secret-key",
        region_name="us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def get_object(path: str) -> bytes:
    return storage().get_object(Bucket="media", Key=path)["Body"].read()


def rows(sql: str, *params):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def one(sql: str, *params):
    result = rows(sql, *params)
    assert len(result) == 1, f"expected one row, got {len(result)}: {sql}"
    return result[0]


def media_for_user():
    return rows(
        "select id, kind, title, canonical_source_url, processing_status, browser_capture_sha256, created_at from media where created_by_user_id = %s order by created_at",
        USER_ID,
    )


def sessions_for_user():
    return rows(
        "select id, kind, filename, upload_generation, published_media_id, published_source_attempt_id, published_at, verification_error_code, transport_failed_at, input_origin from media_upload_sessions where created_by_user_id = %s order by created_at",
        USER_ID,
    )


def attempts_for_media(media_id):
    return rows(
        "select id, source_type, status, attempt_no, source_payload, error_code from media_source_attempts where media_id = %s order by attempt_no",
        media_id,
    )


def entries_for_media(media_id):
    return rows(
        "select le.library_id, l.name, l.is_default from library_entries le join libraries l on l.id = le.library_id where le.media_id = %s order by l.is_default desc, l.name",
        media_id,
    )


def fragments_for_media(media_id):
    return rows("select idx, html_sanitized, canonical_text from fragments where media_id = %s order by idx", media_id)


def ensure_user_bootstrapped():
    """ensure the harness user exists with a default library (the api does this on first auth)."""
    return rows("select id, email from users where id = %s", USER_ID)


def create_library(name: str) -> str:
    """insert a writable non-default library owned by the harness user (the governance owner's shape)."""
    library_id = str(uuid.uuid4())
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "insert into libraries (id, name, owner_user_id, is_default, created_at, updated_at) values (%s, %s, %s, false, now(), now())",
            (library_id, name, USER_ID),
        )
        cur.execute(
            "insert into memberships (library_id, user_id, role, created_at) values (%s, %s, 'admin', now())",
            (library_id, USER_ID),
        )
    return library_id


def delete_library(library_id: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("delete from library_entries where library_id = %s", (library_id,))
        cur.execute("delete from memberships where library_id = %s", (library_id,))
        cur.execute("delete from libraries where id = %s", (library_id,))


def reset_user_content() -> None:
    """remove the harness user's media/sessions through the product's deletion owner (local only)."""
    import subprocess

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    env = dict(os.environ)
    env.update({
        "NEXUS_ENV": "local",
        "DATABASE_URL": "postgresql+psycopg://postgres:postgres@localhost:54320/postgres",
        "R2_S3_API_ORIGIN": "http://127.0.0.1:9000",
        "R2_ACCESS_KEY_ID": "nexus-local-access-key",
        "R2_SECRET_ACCESS_KEY": "nexus-local-secret-key",
        "R2_BUCKET": "media",
        "R2_REGION": "us-east-1",
        "SUPABASE_ISSUER": "http://127.0.0.1:54321/auth/v1",
        "SUPABASE_JWKS_URL": "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
        "SUPABASE_AUDIENCES": "authenticated",
    })
    subprocess.run(
        ["uv", "run", "--frozen", "--no-sync", "python", os.path.join(root, "tools", "firefox-harness", "e2e", "reset.py")],
        cwd=os.path.join(root, "python"), env=env, check=True,
    )
