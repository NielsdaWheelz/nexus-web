"""Rename x capture bindings in place and index bound recovery targets.

Writers and workers must stop before upgrade. Session and source attempt ids,
packet paths, receipts and history are unchanged. Malformed old bindings abort.
"""

from alembic import op
import sqlalchemy as sa

revision = "0322"
down_revision = "0321"
branch_labels = None
depends_on = None


def upgrade() -> None:
    db = op.get_bind()
    for table, column, condition in (
        ("media_upload_sessions", "input_origin", "input_origin->>'kind' = 'BrowserCapture'"),
        ("media_source_attempts", "source_payload", "source_type = 'browser_article_capture'"),
    ):
        rows = db.execute(sa.text(f"SELECT id, {column} FROM {table} WHERE {condition}")).mappings()
        for row in rows:
            payload = dict(row[column])
            if "x_article_binding" not in payload or "capture_binding" in payload:
                raise RuntimeError(f"0322 invalid capture binding in {table} {row['id']}")
            binding = payload.pop("x_article_binding")
            if binding is not None:
                if not isinstance(binding, dict) or set(binding) != {"article_id", "native_target"}:
                    raise RuntimeError(f"0322 invalid x binding in {table} {row['id']}")
                article_id = binding["article_id"]
                target = binding["native_target"]
                if (
                    not isinstance(article_id, str)
                    or not article_id.isascii()
                    or not article_id.isdigit()
                ):
                    raise RuntimeError(f"0322 invalid x identity in {table} {row['id']}")
                if target is not None:
                    from uuid import UUID

                    if not isinstance(target, dict) or set(target) != {
                        "media_id",
                        "expected_source_attempt_id",
                        "expected_reader_generation",
                    }:
                        raise RuntimeError(f"0322 invalid x target in {table} {row['id']}")
                    try:
                        UUID(target["media_id"])
                        UUID(target["expected_source_attempt_id"])
                    except (ValueError, TypeError, AttributeError) as exc:
                        raise RuntimeError(
                            f"0322 invalid target identity in {table} {row['id']}"
                        ) from exc
                    generation = target["expected_reader_generation"]
                    if generation is not None and (type(generation) is not int or generation < 1):
                        raise RuntimeError(f"0322 invalid generation in {table} {row['id']}")
                binding = {"kind": "XArticle", "article_id": article_id, "target": target}
            payload["capture_binding"] = binding
            import json

            db.execute(
                sa.text(f"UPDATE {table} SET {column}=CAST(:payload AS jsonb) WHERE id=:id"),
                {"payload": json.dumps(payload), "id": row["id"]},
            )
    op.execute("""CREATE INDEX ix_upload_web_recovery_target ON media_upload_sessions
        (created_by_user_id, (input_origin->'capture_binding'->'target'->>'media_id'))
        WHERE input_origin->'capture_binding'->>'kind'='WebRecovery'""")


def downgrade() -> None:
    raise RuntimeError("0322 is a hard cutover")
