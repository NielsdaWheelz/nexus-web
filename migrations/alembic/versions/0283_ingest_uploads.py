"""Upload sessions are named by their client-minted id and recreated, not reported.

Revision ID: 0283
Revises: 0282

A create carries the session's own id, and a failed PUT is answered by creating the
same session again (a new generation), so ``idempotency_key`` and the transport-failure
columns have no reader; every in-process storage write is reclaimed by the orphan sweep,
so the reservation ledger's jobs have no handler. Writers are stopped. Nothing here
refuses: every row converts.

1. ``idempotency_key`` (with ``uq_media_upload_sessions_viewer_idempotency``),
   ``transport_failure_kind``, ``transport_http_status`` and ``transport_failed_at`` are
   dropped. A session that read ``TransportFailed`` now derives ``CapabilityExpired``
   once its five-minute url has lapsed (it had, long before): the same Imports group,
   the same Retry upload and Remove;
2. every stored ``UploadFailed`` history payload (``event_type = 'Failed'`` in
   ``media_upload_events``) loses its ``transport`` key. The envelope's ``failure_code``
   (``E_UPLOAD_TRANSPORT_FAILED`` for a transport report, the verification code
   otherwise) still says what happened;
3. every ``storage_object_cleanup`` job is deleted: an armed or delete-required
   reservation's ``media/`` path goes to the orphan sweep (24 hours or more later), an
   ``uploads/`` path to R2's one-day lifecycle rule.

Irreversible: the release's pre-migration backup holds the old columns.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0283"
down_revision: str | Sequence[str] | None = "0282"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE media_upload_sessions
            DROP CONSTRAINT uq_media_upload_sessions_viewer_idempotency,
            DROP COLUMN idempotency_key,
            DROP COLUMN transport_failure_kind,
            DROP COLUMN transport_http_status,
            DROP COLUMN transport_failed_at;

        UPDATE media_upload_events SET payload = payload - 'transport'
        WHERE event_type = 'Failed' AND payload ? 'transport';

        DELETE FROM background_jobs WHERE kind = 'storage_object_cleanup';
    """)


def downgrade() -> None:
    raise NotImplementedError("0283 is irreversible; restore the pre-release backup")
