"""physical episode memberships and library-owned podcast delivery.

revision 0310; parent 0309. data effects: personal follows become default rules;
sole-owner named show entries become named rules and physical eligible episodes.
shared show entries abort with their identities rather than widening access.
playback defaults and exact versions move independently. completed history retains
terminal operation resources; other history restarts at the head with every known
canonical identity processed, preserving prior removals. runnable old jobs settle
as superseded with invalidated claims before their owners disappear. show-entry
receipts remain history but lose undo authority. authored work, suppression,
listening state and existing media placements survive. irreversible; restore backup.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0310"
down_revision: str | Sequence[str] | None = "0309"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    ambiguous = db.execute(
        sa.text("""
        SELECT le.id, le.library_id FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        WHERE le.podcast_id IS NOT NULL AND (
            l.is_default OR l.system_key IS NOT NULL OR
            (SELECT count(*) FROM memberships m WHERE m.library_id = l.id) <> 1 OR
            NOT EXISTS (SELECT 1 FROM memberships m WHERE m.library_id = l.id
                        AND m.user_id = l.owner_user_id AND m.role = 'admin'))
        ORDER BY le.id
    """)
    ).all()
    if ambiguous:
        raise RuntimeError(f"0310 cannot convert shared or invalid show entries: {ambiguous}")
    invalid = db.execute(
        sa.text("""
        SELECT s.id FROM podcast_subscriptions s
        LEFT JOIN libraries l ON l.owner_user_id = s.user_id AND l.is_default
        LEFT JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
        WHERE l.id IS NULL OR l.system_key IS NOT NULL OR b.id IS NULL
           OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.library_id=l.id
                          AND m.user_id=s.user_id AND m.role='admin')
           OR s.settings_version < 1
           OR (s.default_playback_speed IS NOT NULL AND
               (s.default_playback_speed < 0.5 OR s.default_playback_speed > 3))
           OR (s.pause_shortening_mode IS NOT NULL AND
               s.pause_shortening_mode NOT IN ('Off', 'Natural'))
           OR (b.completed_at IS NOT NULL AND b.failed_at IS NOT NULL)
        ORDER BY s.id
    """)
    ).all()
    if invalid:
        raise RuntimeError(f"0310 cannot convert subscriptions: {invalid}")
    db.execute(
        sa.text("""
        CREATE TABLE podcast_feed_runs (
            id uuid PRIMARY KEY,
            podcast_id uuid NOT NULL REFERENCES podcasts(id),
            attempt_version bigint NOT NULL DEFAULT 1,
            step_no bigint NOT NULL DEFAULT 0,
            job_id uuid REFERENCES background_jobs(id),
            pending_urls text[] NOT NULL DEFAULT '{}',
            visited_urls text[] NOT NULL DEFAULT '{}',
            had_coverage_gaps boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            started_at timestamptz,
            completed_at timestamptz,
            failed_at timestamptz,
            cancelled_at timestamptz,
            error_code text,
            error_detail text
        );
        CREATE TABLE podcast_library_imports (
            id uuid PRIMARY KEY,
            library_id uuid NOT NULL REFERENCES libraries(id),
            run_id uuid NOT NULL UNIQUE REFERENCES podcast_feed_runs(id),
            added_count bigint NOT NULL DEFAULT 0,
            already_present_count bigint NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE library_podcast_subscriptions (
            id uuid PRIMARY KEY,
            library_id uuid NOT NULL REFERENCES libraries(id),
            podcast_id uuid NOT NULL REFERENCES podcasts(id),
            initial_import_id uuid NOT NULL UNIQUE REFERENCES podcast_library_imports(id),
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (library_id, podcast_id)
        );
        CREATE TABLE podcast_import_processed_episodes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            import_id uuid NOT NULL REFERENCES podcast_library_imports(id),
            media_id uuid NOT NULL REFERENCES media(id),
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (import_id, media_id)
        );
        CREATE TABLE podcast_playback_settings (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL REFERENCES users(id),
            podcast_id uuid NOT NULL REFERENCES podcasts(id),
            settings_version bigint NOT NULL DEFAULT 1,
            default_playback_speed double precision,
            pause_shortening_mode text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (user_id, podcast_id)
        );
        ALTER TABLE podcasts
            ADD COLUMN sync_run_id uuid UNIQUE REFERENCES podcast_feed_runs(id),
            ADD COLUMN next_sync_at timestamptz,
            ADD COLUMN consecutive_sync_failures integer NOT NULL DEFAULT 0,
            ADD COLUMN last_checked_at timestamptz,
            ADD COLUMN last_check_had_coverage_gaps boolean,
            ADD COLUMN last_check_error_code text,
            ADD COLUMN last_check_error_detail text;
        ALTER TABLE podcast_episodes
            ADD COLUMN chapters_source_url text,
            ADD COLUMN chapters_fetched_at timestamptz,
            ADD COLUMN chapters_job_id uuid REFERENCES background_jobs(id);
        CREATE INDEX ix_podcast_feed_runs_podcast ON podcast_feed_runs(podcast_id);
        CREATE INDEX ix_podcast_library_imports_library ON podcast_library_imports(library_id);
        CREATE INDEX ix_library_podcast_subscriptions_podcast
            ON library_podcast_subscriptions(podcast_id);
        CREATE INDEX ix_podcast_import_processed_media ON podcast_import_processed_episodes(media_id);
        CREATE INDEX ix_podcasts_next_sync ON podcasts(next_sync_at, id);
    """)
    )
    db.execute(
        sa.text("""
        CREATE TEMP TABLE podcast_converted_rules ON COMMIT DROP AS
        SELECT s.id, l.id AS library_id, s.podcast_id, gen_random_uuid() AS import_id,
               gen_random_uuid() AS run_id, s.created_at,
               b.completed_at IS NOT NULL AND NOT b.had_rejected_items AS complete,
               b.started_at, b.completed_at,
               s.last_checked_at, s.sync_had_rejected_items, s.sync_error_code,
               s.sync_error_message
        FROM podcast_subscriptions s
        JOIN libraries l ON l.owner_user_id = s.user_id AND l.is_default
        JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
        UNION ALL
        SELECT le.id, le.library_id, le.podcast_id, gen_random_uuid(), gen_random_uuid(),
               le.created_at,
               COALESCE(b.completed_at IS NOT NULL AND NOT b.had_rejected_items, false),
               b.started_at, b.completed_at,
               NULL::timestamptz, NULL::boolean, NULL::text, NULL::text
        FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        LEFT JOIN podcast_subscriptions s
          ON s.user_id = l.owner_user_id AND s.podcast_id = le.podcast_id
        LEFT JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
        WHERE le.podcast_id IS NOT NULL;

        CREATE TEMP TABLE podcast_converted_members ON COMMIT DROP AS
        SELECT le.library_id, pe.media_id, le.created_at, le.position AS show_position,
               pe.published_at, le.id AS show_entry_id
        FROM library_entries le
        JOIN libraries l ON l.id = le.library_id
        JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
        WHERE le.podcast_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_media_deletions d
                          WHERE d.user_id = l.owner_user_id AND d.media_id = pe.media_id)
          AND NOT EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id = pe.media_id)
          AND (
            EXISTS (SELECT 1 FROM library_entries held
                    JOIN memberships m ON m.library_id = held.library_id
                    WHERE held.media_id = pe.media_id AND m.user_id = l.owner_user_id)
            OR EXISTS (SELECT 1 FROM resource_grants g
                       LEFT JOIN highlights h ON g.subject_scheme = 'highlight'
                         AND h.id = g.subject_id
                       WHERE (g.grantee_user_id = l.owner_user_id
                              OR g.created_by_user_id = l.owner_user_id)
                         AND ((g.subject_scheme = 'media' AND g.subject_id = pe.media_id)
                              OR h.anchor_media_id = pe.media_id))
          );
        INSERT INTO podcast_playback_settings
            (id,user_id,podcast_id,settings_version,default_playback_speed,
             pause_shortening_mode,created_at,updated_at)
        SELECT gen_random_uuid(),user_id,podcast_id,settings_version,default_playback_speed,
               pause_shortening_mode,created_at,updated_at
        FROM podcast_subscriptions;

        INSERT INTO podcast_feed_runs
            (id,podcast_id,pending_urls,created_at,updated_at,started_at,completed_at)
        SELECT r.run_id,r.podcast_id,
               CASE WHEN r.complete THEN '{}'::text[] ELSE ARRAY[p.feed_url] END,
               r.created_at,now(),CASE WHEN r.complete THEN r.started_at END,
               CASE WHEN r.complete THEN r.completed_at END
        FROM podcast_converted_rules r JOIN podcasts p ON p.id = r.podcast_id;
        INSERT INTO podcast_library_imports(id,library_id,run_id,created_at)
        SELECT import_id,library_id,run_id,created_at FROM podcast_converted_rules;
        INSERT INTO library_podcast_subscriptions(id,library_id,podcast_id,initial_import_id,created_at)
        SELECT id,library_id,podcast_id,import_id,created_at FROM podcast_converted_rules;
        CREATE TEMP TABLE podcast_restart_jobs ON COMMIT DROP AS
        SELECT gen_random_uuid() AS id,run_id FROM podcast_converted_rules WHERE NOT complete;
        INSERT INTO background_jobs(id,kind,payload,dedupe_key,priority,max_attempts)
        SELECT id,'podcast_feed_page',jsonb_build_object(
            'run_id',run_id::text,'expected_attempt_version',1,'expected_step_no',0),
            'podcast-feed:' || run_id::text || ':1:0',100,3 FROM podcast_restart_jobs;
        UPDATE podcast_feed_runs r SET job_id=j.id FROM podcast_restart_jobs j WHERE j.run_id=r.id;
        INSERT INTO podcast_import_processed_episodes(import_id,media_id)
        SELECT r.import_id,pe.media_id FROM podcast_converted_rules r
        JOIN podcast_episodes pe ON pe.podcast_id = r.podcast_id WHERE NOT r.complete;

        DELETE FROM library_entries WHERE podcast_id IS NOT NULL;
        CREATE TEMP TABLE podcast_ordered_members ON COMMIT DROP AS
        SELECT desired.*, row_number() OVER (PARTITION BY show_entry_id ORDER BY media_id) AS identity_ordinal,
               row_number() OVER (
                   PARTITION BY library_id ORDER BY show_position,published_at DESC NULLS LAST,
                                                    media_id) AS ordinal
        FROM podcast_converted_members desired
        WHERE NOT EXISTS (SELECT 1 FROM library_entries held
                          WHERE held.library_id = desired.library_id
                            AND held.media_id = desired.media_id);
    """)
    )
    overflow = db.execute(
        sa.text("""
        SELECT n.library_id FROM podcast_ordered_members n GROUP BY n.library_id
        HAVING count(*) + (SELECT COALESCE(max(position),-1) FROM library_entries e
                           WHERE e.library_id = n.library_id) > 2147483647
    """)
    ).first()
    if overflow:
        raise RuntimeError(
            f"0310 cannot append episodes in library {overflow[0]}: position overflow"
        )
    db.execute(
        sa.text("""
        INSERT INTO library_entries(id,library_id,media_id,created_at,position)
        SELECT CASE WHEN n.identity_ordinal = 1 THEN n.show_entry_id ELSE gen_random_uuid() END,
               n.library_id,n.media_id,n.created_at,
               ((SELECT COALESCE(max(position),-1) FROM library_entries e
                 WHERE e.library_id = n.library_id) + n.ordinal)::integer
        FROM podcast_ordered_members n ORDER BY n.library_id,n.ordinal;
        UPDATE podcast_library_imports i SET already_present_count = (
            SELECT count(*) FROM library_entries e JOIN podcast_episodes pe ON pe.media_id = e.media_id
            JOIN podcast_feed_runs r ON r.id = i.run_id
            WHERE e.library_id = i.library_id AND pe.podcast_id = r.podcast_id);
        UPDATE libraries SET order_revision = nextval('collection_order_revision_seq')
        WHERE id IN (SELECT library_id FROM podcast_converted_rules);
        UPDATE podcasts p SET next_sync_at = date_trunc('hour',now()) + interval '1 hour'
        WHERE EXISTS (SELECT 1 FROM library_podcast_subscriptions s WHERE s.podcast_id = p.id);
        UPDATE podcasts p SET last_checked_at = old.last_checked_at,
            last_check_had_coverage_gaps = old.sync_had_rejected_items,
            last_check_error_code = old.sync_error_code,
            last_check_error_detail = old.sync_error_message
        FROM (SELECT DISTINCT ON (podcast_id) * FROM podcast_converted_rules
              ORDER BY podcast_id,last_checked_at DESC NULLS LAST,id) old
        WHERE old.podcast_id = p.id;

        UPDATE background_jobs SET status = 'succeeded', claimed_by = NULL,
            lease_expires_at = NULL,execution_id = gen_random_uuid(),finished_at = now(),
            updated_at = now(),result = '{"status":"superseded"}'::jsonb
        WHERE kind IN ('podcast_sync_subscription_job','podcast_backfill_subscription')
          AND status IN ('pending','failed','running');
        UPDATE background_job_capacity_leases SET job_id = NULL,lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE job_id IN (SELECT id FROM background_jobs
                         WHERE kind IN ('podcast_sync_subscription_job','podcast_backfill_subscription'));
        UPDATE tool_calls SET created_refs = (
            SELECT jsonb_agg(CASE WHEN item->>'kind' = 'entry'
                                       AND item->>'target_scheme' = 'podcast'
                                 THEN jsonb_set(item,'{order_revision}','null'::jsonb) ELSE item END)
            FROM jsonb_array_elements(created_refs) item)
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(created_refs) item
                      WHERE item->>'kind' = 'entry' AND item->>'target_scheme' = 'podcast');
        DROP TABLE podcast_subscription_backfills;
        DROP TABLE podcast_subscriptions;
        DROP FUNCTION notify_podcast_subscription_backfill_lifecycle();
        DROP FUNCTION notify_podcast_subscription_lifecycle();
        ALTER TABLE library_entries DROP CONSTRAINT ck_library_entries_exactly_one_target;
        ALTER TABLE library_entries DROP COLUMN podcast_id;
        ALTER TABLE library_entries ALTER COLUMN media_id SET NOT NULL;
    """)
    )


def downgrade() -> None:
    raise NotImplementedError("0310 is irreversible; restore the pre-release backup")
