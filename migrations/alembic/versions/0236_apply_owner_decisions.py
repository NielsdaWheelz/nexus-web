"""Apply the owner decisions that need DDL/DML: retire the historical Oracle and
Dossier failure vocabularies onto the current ones, close the message-role and
tool record-kind vocabularies, drop the superseded source-attempt status, and
delete conversation library sharing.

Revision ID: 0236
Revises: 0235
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0236"
down_revision: str | Sequence[str] | None = "0235"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Retired Oracle failure code -> the current code that states the same fact.
_ORACLE_FAILURE_CODE_MAP = {
    "rate_limited": "E_RATE_LIMITED",
    "provider_unavailable": "runtime_unavailable",
    "stream_interrupted": "runtime_unavailable",
    "defect": "runtime_unavailable",
    "E_INTERNAL": "runtime_unavailable",
    "invalid_structured_output": "invalid_output",
    "incomplete": "output_limit",
    "refused": "policy_violation",
    "E_BILLING_REQUIRED": "quota",
    "E_TOKEN_BUDGET_EXCEEDED": "quota",
    "budget_exceeded": "quota",
}

# Retired Dossier failure code -> the current code that states the same fact.
_DOSSIER_FAILURE_CODE_MAP = {
    "EntitlementDenied": "Quota",
    "BudgetExceeded": "Quota",
    "ProviderRefused": "PolicyViolation",
    "ProviderIncomplete": "OutputLimit",
}


def _map_oracle_failures() -> None:
    for retired, current in _ORACLE_FAILURE_CODE_MAP.items():
        op.execute(
            f"UPDATE oracle_readings SET error_code = '{current}' WHERE error_code = '{retired}'"
        )
        op.execute(
            "UPDATE oracle_reading_events "
            f"SET payload = jsonb_set(payload, '{{error_code}}', '\"{current}\"') "
            "WHERE event_type = 'historical_done' "
            f"AND payload ->> 'error_code' = '{retired}'"
        )
    op.execute(
        "UPDATE oracle_reading_events SET event_type = 'done' WHERE event_type = 'historical_done'"
    )
    op.drop_constraint("ck_oracle_reading_events_type", "oracle_reading_events", type_="check")
    op.create_check_constraint(
        "ck_oracle_reading_events_type",
        "oracle_reading_events",
        "event_type IN ('meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', 'done')",
    )


def _map_dossier_failures() -> None:
    for retired, current in _DOSSIER_FAILURE_CODE_MAP.items():
        op.execute(
            f"UPDATE artifact_build_failures SET failure_code = '{current}' "
            f"WHERE failure_code = '{retired}'"
        )
        op.execute(
            "UPDATE artifact_build_events "
            f"SET payload = jsonb_set(payload, '{{failure_code}}', '\"{current}\"') "
            "WHERE event_type = 'HistoricalFailed' "
            f"AND payload ->> 'failure_code' = '{retired}'"
        )
    op.execute(
        "UPDATE artifact_build_events SET event_type = 'Failed' "
        "WHERE event_type = 'HistoricalFailed'"
    )
    op.drop_constraint("ck_artifact_build_events_type", "artifact_build_events", type_="check")
    op.create_check_constraint(
        "ck_artifact_build_events_type",
        "artifact_build_events",
        "event_type IN ('Started', 'Progress', 'Succeeded', 'Failed', 'Cancelled')",
    )


def upgrade() -> None:
    _map_oracle_failures()
    _map_dossier_failures()

    # Chat messages are only ever written by a user or by the assistant; a
    # role='system' row would fail this narrowing loudly, as intended.
    op.drop_constraint("ck_messages_role", "messages", type_="check")
    op.create_check_constraint(
        "ck_messages_role",
        "messages",
        "role IN ('user', 'assistant')",
    )
    op.drop_constraint("ck_messages_parent_role_shape", "messages", type_="check")
    op.create_check_constraint(
        "ck_messages_parent_role_shape",
        "messages",
        "(role = 'user' AND parent_message_id IS NULL) OR parent_message_id IS NOT NULL",
    )

    # A surviving rejected_provider_call row (0217 manufactured them from
    # pre-cutover data) fails this loudly, as intended.
    op.create_check_constraint(
        "ck_message_tool_calls_record_kind",
        "message_tool_calls",
        "record_kind IN ('attached_context', 'current_execution', 'historical_execution')",
    )

    op.drop_constraint("ck_media_source_attempts_status", "media_source_attempts", type_="check")
    op.create_check_constraint(
        "ck_media_source_attempts_status",
        "media_source_attempts",
        "status IN ('accepted', 'queued', 'running', 'succeeded', 'failed')",
    )

    op.drop_table("conversation_shares")
    op.drop_constraint("ck_conversations_sharing", "conversations", type_="check")
    op.drop_column("conversations", "sharing")


def downgrade() -> None:
    raise NotImplementedError("0236 is an irreversible owner-decision hard cutover")
