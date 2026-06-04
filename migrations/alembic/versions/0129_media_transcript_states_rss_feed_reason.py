"""widen last_request_reason / audit request_reason CHECKs to allow rss_feed

Revision ID: 0129
Revises: 0128
Create Date: 2026-06-03

0038 added 'rss_feed' to ck_podcast_transcription_jobs_request_reason and
ck_podcast_transcript_versions_request_reason but left the two sibling reason
CHECKs un-updated. This widens both: media_transcript_states.last_request_reason
(written 'rss_feed' by the unified transcript writer) and
podcast_transcript_request_audits.request_reason (the service-layer reason set
already admits 'rss_feed').
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0129"
down_revision: str | Sequence[str] | None = "0128"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_media_transcript_states_last_request_reason",
        "media_transcript_states",
        type_="check",
    )
    op.create_check_constraint(
        "ck_media_transcript_states_last_request_reason",
        "media_transcript_states",
        (
            "last_request_reason IS NULL OR last_request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
            ")"
        ),
    )
    op.drop_constraint(
        "ck_podcast_transcript_request_audits_reason",
        "podcast_transcript_request_audits",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcript_request_audits_reason",
        "podcast_transcript_request_audits",
        (
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
            ")"
        ),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0129 is not reversible")
