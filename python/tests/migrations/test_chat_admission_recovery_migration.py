"""0225→0226 requires empty chat history and establishes sole receipt ownership."""

from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.services.bootstrap import ensure_user_and_default_library


def test_chat_admission_cutover_requires_empty_history_and_sole_receipt_ownership(
    empty_migration_database_url: str,
) -> None:
    root = Path(__file__).parents[3] / "migrations"
    config = Config(root / "alembic.ini")
    config.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(config, "0225")
    engine = create_engine(empty_migration_database_url)
    owner, wire_key, original_hash = uuid4(), "m" * 128, "b" * 64
    try:
        with Session(engine) as db:
            ensure_user_and_default_library(db, owner, f"migration-{owner}@example.invalid")
            conversation = Conversation(
                owner_user_id=owner, title="Admission migration", sharing="private", next_seq=3
            )
            db.add(conversation)
            db.flush()
            user = Message(
                conversation_id=conversation.id,
                seq=1,
                role="user",
                content="Private original content",
                status="complete",
            )
            db.add(user)
            db.flush()
            assistant = Message(
                conversation_id=conversation.id,
                seq=2,
                role="assistant",
                content="Answer",
                status="complete",
                parent_message_id=user.id,
            )
            db.add(assistant)
            db.flush()
            run_id = uuid4()
            conversation_id, assistant_id = conversation.id, assistant.id
            # Post-reset 0225 storage is deliberately independent of the current
            # ORM: the cutover removes both of these old identity columns.
            db.execute(
                text(
                    """
                    INSERT INTO chat_runs (
                        id, owner_user_id, conversation_id, user_message_id,
                        assistant_message_id, idempotency_key, payload_hash,
                        generation_spec, status
                    ) VALUES (
                        :id, :owner, :conversation, :user_message,
                        :assistant_message, :key, :hash, '{}'::jsonb, 'complete'
                    )
                    """
                ),
                {
                    "id": run_id,
                    "owner": owner,
                    "conversation": conversation_id,
                    "user_message": user.id,
                    "assistant_message": assistant_id,
                    "key": wire_key,
                    "hash": original_hash,
                },
            )
            user_id = user.id
            db.commit()
        upgrade_error: RuntimeError | None = None
        try:
            command.upgrade(config, "head")
        except RuntimeError as error:
            upgrade_error = error
        assert upgrade_error is not None, (
            "pre-receipt chat history bypassed the hard-cut maintenance gate"
        )
        assert "pre-receipt chat history" in str(upgrade_error)
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0225"
            assert connection.execute(
                text("SELECT idempotency_key, payload_hash FROM chat_runs WHERE id=:id"),
                {"id": run_id},
            ).one() == (wire_key, original_hash)
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM resource_mutations WHERE mutation_scope='chat:admission'"
                    )
                )
                == 0
            ), "failed cutover manufactured a receipt from an unverifiable legacy command"
            # Test arrangement models the separately authorized maintenance reset;
            # the migration itself must neither erase history nor translate its hash.
            connection.execute(text("DELETE FROM chat_runs WHERE id=:id"), {"id": run_id})

        command.upgrade(config, "head")
        schema = inspect(engine)
        assert "rate_limit_inflight" not in schema.get_table_names()
        assert {"idempotency_key", "payload_hash"}.isdisjoint(
            column["name"] for column in schema.get_columns("chat_runs")
        ), "chat_runs retained a second admission identity after the hard cut"
        assert "ck_chat_runs_idempotency_key_length" not in {
            constraint["name"] for constraint in schema.get_check_constraints("chat_runs")
        }
        assert "uix_chat_runs_owner_idempotency_key" not in {
            constraint["name"] for constraint in schema.get_unique_constraints("chat_runs")
        }
        assert any(
            item["column_names"] == ["assistant_message_id"]
            for item in schema.get_unique_constraints("chat_runs")
        )
        with engine.begin() as connection:
            insert_run = text(
                "INSERT INTO chat_runs "
                "(id, owner_user_id, conversation_id, user_message_id, "
                "assistant_message_id, generation_spec, status) "
                "VALUES (:id, :owner, :conversation, :user_message, "
                ":assistant_message, '{}'::jsonb, 'complete')"
            )
            run_values = {
                "id": run_id,
                "owner": owner,
                "conversation": conversation_id,
                "user_message": user_id,
                "assistant_message": assistant_id,
            }
            connection.execute(insert_run, run_values)
            with pytest.raises(IntegrityError, match="uq_chat_runs_assistant_message"):
                with connection.begin_nested():
                    connection.execute(insert_run, {**run_values, "id": uuid4()})

    finally:
        engine.dispose()
