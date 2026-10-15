"""Source attempts carry client ids and recover through their chain, not a ledger.

Revision ID: 0282
Revises: 0281

Url accepts carry a client-minted attempt id and recoveries find their own effect as
the expected attempt's successor, so ``idempotency_key`` and ``intent_key`` have no
reader; every acceptance commits its job in its own transaction, so the periodic
reconciler is gone; ``video_transcript`` has no producer. Writers are stopped.

Refusals, checked together before any change, each raising with its count:

1. an attempt of type ``video_transcript``;
2. a payload still naming ``source_storage_path`` (a capture the release's one-shot
   conversion never rewrote);
3. a ``youtube_video``, ``x_author_thread`` or ``x_post`` attempt with no
   ``provider_target_ref`` and no ``video_id``/``post_id`` in its payload to take it from;
4. a media whose latest attempt is ``accepted``, ``queued`` or ``running`` with no
   ``ingest_media_source`` job in ``pending``, ``failed``, ``running`` or ``dead``, other
   than the stranded Post Room shape step 7 converts (the old reconciler drained these;
   the release census proves zero first).

Then, in order:

5. ``retained_legacy_paths`` leaves every payload: those legacy capture blobs become
   unowned and the storage orphan sweep deletes them at least 24 hours later;
6. ``provider_target_ref`` is backfilled from the payload's ``video_id``/``post_id``
   (the adapters read the column only);
7. a stranded Post Room message (latest attempt ``email_message``, ``accepted``, no job,
   its media ``failed``: its html was never stored) becomes a failed attempt with its
   terminal ``SourceFailed`` history event, and the attempt's and the media's error code
   and message read ``E_STORAGE_MISSING``. Imports shows it failed with no retry; the
   owner deletes it and the sender resends;
8. every ``reconcile_stale_ingest_media_job`` row is deleted;
9. ``idempotency_key`` (with its unique index and check) and ``intent_key`` are dropped,
   and ``ck_media_source_attempts_source_type`` no longer admits ``video_transcript``.

Irreversible: the release's pre-migration backup holds the old columns.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0282"
down_revision: str | Sequence[str] | None = "0281"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TYPES = (
    "generic_web_url x_author_thread x_post youtube_video remote_pdf_url remote_epub_url"
    " uploaded_pdf_file uploaded_epub_file browser_article_capture browser_pdf_capture"
    " browser_epub_capture podcast_episode_transcript email_message"
).split()


def upgrade() -> None:
    op.execute("""
        CREATE TEMPORARY TABLE latest_attempts ON COMMIT DROP AS
        SELECT DISTINCT ON (a.media_id) a.id, a.media_id, a.source_type, a.status, a.job_id,
               m.processing_status::text AS media_status
        FROM media_source_attempts a JOIN media m ON m.id = a.media_id
        ORDER BY a.media_id, a.attempt_no DESC, a.created_at DESC, a.id DESC;

        CREATE TEMPORARY TABLE stranded_email ON COMMIT DROP AS
        SELECT id, media_id FROM latest_attempts
        WHERE source_type = 'email_message' AND status = 'accepted' AND job_id IS NULL
          AND media_status = 'failed';

        DO $$
        DECLARE
            video_transcript bigint;
            legacy_path bigint;
            no_target bigint;
            jobless bigint;
        BEGIN
            SELECT count(*) INTO video_transcript FROM media_source_attempts
            WHERE source_type = 'video_transcript';
            SELECT count(*) INTO legacy_path FROM media_source_attempts
            WHERE source_payload ? 'source_storage_path';
            SELECT count(*) INTO no_target FROM media_source_attempts
            WHERE source_type IN ('youtube_video', 'x_author_thread', 'x_post')
              AND provider_target_ref IS NULL
              AND COALESCE(source_payload ->> 'video_id', source_payload ->> 'post_id') IS NULL;
            SELECT count(*) INTO jobless FROM latest_attempts l
            WHERE l.status IN ('accepted', 'queued', 'running')
              AND l.id NOT IN (SELECT id FROM stranded_email)
              AND NOT EXISTS (
                  SELECT 1 FROM background_jobs j
                  WHERE j.id = l.job_id AND j.kind = 'ingest_media_source'
                    AND j.status IN ('pending', 'failed', 'running', 'dead'));
            IF video_transcript + legacy_path + no_target + jobless > 0 THEN
                RAISE EXCEPTION '0282 refuses: % video_transcript attempts, % payloads with '
                    'source_storage_path, % provider attempts without a target, % media whose '
                    'latest attempt is in flight without a live or dead job',
                    video_transcript, legacy_path, no_target, jobless;
            END IF;
        END $$;

        UPDATE media_source_attempts SET source_payload = source_payload - 'retained_legacy_paths'
        WHERE source_payload ? 'retained_legacy_paths';

        UPDATE media_source_attempts
        SET provider_target_ref = COALESCE(source_payload ->> 'video_id',
                                           source_payload ->> 'post_id')
        WHERE source_type IN ('youtube_video', 'x_author_thread', 'x_post')
          AND provider_target_ref IS NULL;

        UPDATE media SET last_error_code = 'E_STORAGE_MISSING',
                         last_error_message = 'The email was never stored.'
        WHERE id IN (SELECT media_id FROM stranded_email);
        UPDATE media_source_attempts
        SET status = 'failed', error_code = 'E_STORAGE_MISSING',
            error_message = 'The email was never stored.',
            finished_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM stranded_email);
        INSERT INTO media_processing_events (id, media_id, event_type, stage, failure_code, payload)
        SELECT gen_random_uuid(), media_id, 'Failed', 'SourceProcessing', 'E_STORAGE_MISSING',
               jsonb_build_object('source_attempt_id', id, 'execution_id', NULL,
                                  'origin', 'Domain', 'terminal', true, 'progress', NULL)
        FROM stranded_email;

        DELETE FROM background_jobs WHERE kind = 'reconcile_stale_ingest_media_job';

        ALTER TABLE media_source_attempts
            DROP CONSTRAINT ck_media_source_attempts_idempotency_user,
            DROP CONSTRAINT ck_media_source_attempts_source_type;
        DROP INDEX uq_media_source_attempts_idempotency;
        ALTER TABLE media_source_attempts DROP COLUMN idempotency_key, DROP COLUMN intent_key;
    """)
    allowed = ", ".join(f"'{source_type}'" for source_type in _TYPES)
    op.execute(f"""
        ALTER TABLE media_source_attempts ADD CONSTRAINT ck_media_source_attempts_source_type
            CHECK (source_type IN ({allowed}))
    """)


def downgrade() -> None:
    raise NotImplementedError("0282 is irreversible; restore the pre-release backup")
