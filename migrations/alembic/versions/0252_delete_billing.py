"""Delete billing: every account holds every capability, so plans, grants,
Stripe state and the transcription minute ledger go.

Irreversible. The release stops writers and takes a verified backup first; after
this revision that backup is the only copy of the Stripe snapshots, grants,
processed webhook ids and minute history.

Revision ID: 0252
Revises: 0251
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0252"
down_revision: str | Sequence[str] | None = "0251"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table in (
        "billing_accounts",
        "billing_entitlement_overrides",
        "stripe_webhook_events",
        "podcast_transcription_usage_daily",
    ):
        op.drop_table(table)
    # Each column's CHECK and foreign key go with it.
    for column in ("reserved_minutes", "reservation_usage_date", "requested_by_user_id"):
        op.drop_column("podcast_transcription_jobs", column)
    # last_error_code keeps E_PODCAST_QUOTA_EXCEEDED, so the reason survives the relabel.
    op.execute(
        "UPDATE media_transcript_states SET transcript_state = 'failed_provider'"
        " WHERE transcript_state = 'failed_quota'"
    )
    op.drop_constraint("ck_media_transcript_states_state", "media_transcript_states", type_="check")
    op.create_check_constraint(
        "ck_media_transcript_states_state",
        "media_transcript_states",
        "transcript_state IN ('not_requested', 'queued', 'running', 'ready', 'partial',"
        " 'unavailable', 'failed_provider')",
    )
    # Palette history for the deleted pane, including Stripe's ?checkout= return URLs.
    op.execute("DELETE FROM nexus_usages WHERE target_href ~ '^/settings/billing([?#]|$)'")


def downgrade() -> None:
    raise NotImplementedError("0252 is an irreversible billing deletion")
