"""One-click capture identity and guarded document removal.

Stopped writers and a verified backup are required. Backfill acquisition revisions,
expire unpublished browser sessions, and convert settled browser provenance to the
single source binding. Preserve published identities/content and authored evidence.
Normalize upstream thread inputs with explicit null extension admission facts.
Refuse live browser work and inputs whose exact bytes cannot be established.
Downgrade requires the matched backup and binaries.
"""

import json
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision = "0332"
down_revision = "0331"
branch_labels = None
depends_on = None


def _binding(old: object) -> tuple[dict, int | None]:
    if old is None:
        return {"x_article_id": None, "target": None}, None
    if not isinstance(old, dict):
        raise RuntimeError("0332 invalid capture binding")
    kind = old.get("kind")
    if kind == "XArticle" and set(old) == {"kind", "article_id", "target"}:
        article = old["article_id"]
        if (
            not isinstance(article, str)
            or not article.isascii()
            or not article.isdecimal()
        ):
            raise RuntimeError("0332 invalid article identity")
    elif kind == "WebRecovery" and set(old) == {"kind", "target", "source_relation"}:
        if old["source_relation"] not in {"ExactUrl", "AlternativeCopy"}:
            raise RuntimeError("0332 invalid recovery relation")
        article = None
    else:
        raise RuntimeError("0332 unknown capture binding shape")
    target = old["target"]
    if target is None:
        if kind == "WebRecovery":
            raise RuntimeError("0332 recovery target missing")
        return {"x_article_id": article, "target": None}, None
    if not isinstance(target, dict) or set(target) != {
        "media_id",
        "expected_source_attempt_id",
        "expected_reader_generation",
    }:
        raise RuntimeError("0332 invalid capture target")
    UUID(target["media_id"])
    UUID(target["expected_source_attempt_id"])
    generation = target["expected_reader_generation"]
    if generation is not None and (type(generation) is not int or generation < 1):
        raise RuntimeError("0332 invalid reader generation")
    return {
        "x_article_id": article,
        "target": {
            "media_id": target["media_id"],
            "expected_source_attempt_id": target["expected_source_attempt_id"],
        },
    }, generation if kind == "XArticle" else None


def upgrade() -> None:
    db = op.get_bind()
    thread_payloads = []
    for row in db.execute(
        sa.text(
            "SELECT id,source_payload FROM media_source_attempts WHERE source_type='x_author_thread'"
        )
    ).mappings():
        payload = row["source_payload"]
        try:
            if not isinstance(payload, dict) or set(payload) != {
                "capture_input",
                "parent_source_attempt_id",
            }:
                raise ValueError("unexpected thread fields")
            parent = payload["parent_source_attempt_id"]
            if parent is not None:
                if not isinstance(parent, str):
                    raise ValueError("invalid parent identity")
                UUID(parent)
            capture = payload["capture_input"]
            if capture is not None:
                if not isinstance(capture, dict) or set(capture) != {
                    "capture_id",
                    "authorized_capture_ids",
                }:
                    raise ValueError("invalid capture input")
                if (
                    not isinstance(capture["capture_id"], str)
                    or not isinstance(capture["authorized_capture_ids"], list)
                    or any(
                        not isinstance(value, str)
                        for value in capture["authorized_capture_ids"]
                    )
                ):
                    raise ValueError("invalid capture manifest")
                identity = UUID(capture["capture_id"])
                authorized = tuple(
                    UUID(value) for value in capture["authorized_capture_ids"]
                )
                if (
                    identity not in authorized
                    or tuple(sorted(set(authorized))) != authorized
                ):
                    raise ValueError("invalid capture manifest")
        except ValueError as exc:
            raise RuntimeError(f"0332 invalid thread input {row['id']}") from exc
        thread_payloads.append((row["id"], {**payload, "extension_source": None}))

    for attempt_id, payload in thread_payloads:
        db.execute(
            sa.text(
                "UPDATE media_source_attempts SET source_payload=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {"id": attempt_id, "value": json.dumps(payload)},
        )
    live = db.scalar(
        sa.text("""
        SELECT count(*) FROM media_source_attempts a
        LEFT JOIN background_jobs j ON j.id=a.job_id
        WHERE a.source_type IN ('browser_article_capture','browser_pdf_capture','browser_epub_capture')
          AND (j.status IN ('pending','running') OR (
            a.status IN ('accepted','queued','running') AND NOT EXISTS (
              SELECT 1 FROM media_source_attempts newer WHERE newer.media_id=a.media_id
              AND (newer.attempt_no,newer.created_at,newer.id)>(a.attempt_no,a.created_at,a.id))))
    """)
    )
    if live:
        raise RuntimeError(
            f"0332 requires settling {live} live browser source attempts"
        )

    op.add_column(
        "media",
        sa.Column(
            "acquisition_revision",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("nextval('collection_order_revision_seq')"),
        ),
    )

    sessions = list(
        db.execute(
            sa.text("""
        SELECT * FROM media_upload_sessions WHERE input_origin->>'kind'='BrowserCapture'
    """)
        ).mappings()
    )
    published = [row for row in sessions if row["published_at"] is not None]
    # Freeze old records before transforming either provenance owner.
    attempts = list(
        db.execute(
            sa.text("""
        SELECT * FROM media_source_attempts
        WHERE source_type IN ('browser_article_capture','browser_pdf_capture','browser_epub_capture')
    """)
        ).mappings()
    )
    by_attempt = {row["id"]: row for row in attempts}
    for row in sessions:
        origin = row["input_origin"]
        if not isinstance(origin, dict) or set(origin) != {
            "kind",
            "source_url",
            "sha256",
            "capture_binding",
        }:
            raise RuntimeError(f"0332 invalid browser origin {row['id']}")
        binding, _ = _binding(origin["capture_binding"])
        if row["published_at"] is None:
            for table, column in (
                ("media_upload_events", "session_id"),
                ("media_upload_session_destinations", "upload_session_id"),
                ("media_upload_sessions", "id"),
            ):
                db.execute(
                    sa.text(f"DELETE FROM {table} WHERE {column}=:id"),
                    {"id": row["id"]},
                )
            continue
        converted = {
            key: value for key, value in origin.items() if key != "capture_binding"
        }
        converted["source_binding"] = binding
        db.execute(
            sa.text(
                "UPDATE media_upload_sessions SET input_origin=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {"id": row["id"], "value": json.dumps(converted)},
        )

    for row in attempts:
        payload = row["source_payload"]
        article = row["source_type"] == "browser_article_capture"
        if not isinstance(payload, dict) or set(payload) != (
            {"storage_path", "capture_binding"} if article else set()
        ):
            raise RuntimeError(f"0332 unknown browser payload {row['id']}")
        if article:
            binding, generation = _binding(payload["capture_binding"])
            candidates = [
                s
                for s in published
                if (
                    s["published_source_attempt_id"] in by_attempt
                    and by_attempt[s["published_source_attempt_id"]]["media_id"]
                    == row["media_id"]
                    and by_attempt[s["published_source_attempt_id"]][
                        "source_payload"
                    ].get("storage_path")
                    == payload["storage_path"]
                )
            ]
            path = payload["storage_path"]
        else:
            candidates = [
                s
                for s in published
                if s["published_media_id"] == row["media_id"]
                and s["candidate_media_id"] == row["media_id"]
                and s["published_source_attempt_id"] in by_attempt
                and by_attempt[s["published_source_attempt_id"]]["media_id"]
                == row["media_id"]
                and by_attempt[s["published_source_attempt_id"]]["source_type"]
                == row["source_type"]
                and s["kind"]
                == ("pdf" if row["source_type"] == "browser_pdf_capture" else "epub")
            ]
            file = (
                db.execute(
                    sa.text("""
                SELECT storage_path,content_type,size_bytes,source_sha256
                FROM media_file WHERE media_id=:id
            """),
                    {"id": row["media_id"]},
                )
                .mappings()
                .one_or_none()
            )
            if file is None:
                raise RuntimeError(f"0332 missing browser file {row['id']}")
            candidates = [
                s
                for s in candidates
                if s["input_origin"]["sha256"] == file["source_sha256"]
                and s["expected_size_bytes"] == file["size_bytes"]
                and s["content_type"] == file["content_type"]
            ]
            binding, generation = {"x_article_id": None, "target": None}, None
            path = file["storage_path"]
        facts = {
            (s["content_type"], s["expected_size_bytes"], s["input_origin"]["sha256"])
            for s in candidates
        }
        if len(facts) != 1 or not isinstance(path, str) or not path:
            raise RuntimeError(f"0332 cannot prove browser input {row['id']}")
        content_type, size, sha256 = facts.pop()
        converted = {
            "source_binding": binding,
            "base_reader_generation": generation,
            "storage_path": path,
            "content_type": content_type,
            "size_bytes": size,
            "sha256": sha256,
        }
        db.execute(
            sa.text(
                "UPDATE media_source_attempts SET source_payload=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {"id": row["id"], "value": json.dumps(converted)},
        )

    op.drop_index("ix_upload_web_recovery_target", table_name="media_upload_sessions")


def downgrade() -> None:
    raise RuntimeError("0332 is a hard cutover; restore the matched backup")
