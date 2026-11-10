"""Rehome subscriptions and traversal; bind article provenance and account discovery.

Preserve source, episode, rule, operation, alias and playback identities. Existing
recurring walks become catch-up; their claims/cursors stay intact and a fresh head
becomes due. Historical dates remain unverified and existing holdings are a null
discovery baseline. Reader bodies and authored work are unchanged. Stop writers;
duplicate retrieval identities or orphaned episode aliases require explicit repair.
Queue names are converted in place. Episode metadata loses the old retrieval-URL
copies; feed credentials stay source-owned. Article feeds become valid graph
endpoints and resource-state keys. Library-add result facts adopt the feed wire;
recorded tool arguments and receipt identities stay intact. Restore the matched
backup to downgrade.
"""

import json
from typing import Any
from urllib.parse import urlparse, urlunparse

import sqlalchemy as sa
from alembic import op

revision = "0338"
down_revision = "0337"
branch_labels = None
depends_on = None


def _library_add_result(result: dict[str, Any], call_id: object) -> dict[str, Any]:
    """Rename recorded source facts; untouched historical facts are not revalidated."""
    value = result.get("value")
    if not isinstance(value, dict):
        raise RuntimeError(f"0338 invalid library-add result {call_id}: value")
    if "podcast" not in value:
        return result
    if "feed" in value:
        raise RuntimeError(f"0338 ambiguous library-add result {call_id}: source")
    value = value.copy()
    source = value.pop("podcast")
    if source is not None:
        if (
            not isinstance(source, dict)
            or not {"podcast_id", "import_", "subscription"} <= source.keys()
            or {"feed_id", "operation", "import"} & source.keys()
            or not isinstance(source["podcast_id"], str)
            or not source["podcast_id"]
        ):
            raise RuntimeError(f"0338 invalid library-add result {call_id}: admission")
        source = source.copy()
        operation = source.pop("import_")
        if (
            not isinstance(operation, dict)
            or not {"podcast_id", "podcast_title"} <= operation.keys()
            or {"feed_id", "feed_title", "feed_kind"} & operation.keys()
            or operation["podcast_id"] != source["podcast_id"]
        ):
            raise RuntimeError(f"0338 invalid library-add result {call_id}: import")
        subscription = source["subscription"]
        if subscription is not None:
            if (
                not isinstance(subscription, dict)
                or subscription.get("podcast_id") != source["podcast_id"]
                or "feed_id" in subscription
            ):
                raise RuntimeError(f"0338 invalid library-add result {call_id}: subscription")
            subscription = subscription.copy()
            subscription["feed_id"] = subscription.pop("podcast_id")
        operation = operation.copy()
        operation["feed_id"] = operation.pop("podcast_id")
        operation["feed_title"] = operation.pop("podcast_title")
        operation["feed_kind"] = "podcast"
        source["feed_id"] = source.pop("podcast_id")
        source["subscription"] = subscription
        source["operation"] = operation
    value["feed"] = source
    return {**result, "value": value}


def upgrade() -> None:
    db = op.get_bind()
    aliases: dict[str, object] = {}
    for row in db.execute(sa.text("SELECT id,feed_url FROM podcasts ORDER BY id")):
        parsed = urlparse(row.feed_url)
        if parsed.scheme.lower() not in ("https", "http") or not parsed.hostname:
            raise RuntimeError(f"0338 invalid retrieval url for source {row.id}")
        if parsed.username or parsed.password:
            raise RuntimeError(
                f"0338 embedded retrieval credentials for source {row.id}"
            )
        scheme, host, port = parsed.scheme.lower(), parsed.hostname.lower(), parsed.port
        if ":" in host:
            host = f"[{host}]"
        netloc = (
            f"{host}:{port}"
            if port and port != (80 if scheme == "http" else 443)
            else host
        )
        url = urlunparse(
            (scheme, netloc, parsed.path or "/", parsed.params, parsed.query, "")
        )
        if url in aliases:
            raise RuntimeError(
                f"0338 conflicting retrieval identities {aliases[url]} and {row.id}"
            )
        aliases[url] = row.id
    invalid = db.execute(
        sa.text("""
        SELECT i.id FROM podcast_episode_identities i
        LEFT JOIN podcast_episodes e ON e.media_id=i.episode_media_id
        WHERE e.media_id IS NULL OR e.podcast_id<>i.podcast_id
    """)
    ).all()
    if invalid:
        raise RuntimeError(f"0338 cannot convert entry aliases: {invalid}")
    op.execute("""
        ALTER TABLE podcasts RENAME TO feeds;
        ALTER TABLE feeds ADD COLUMN kind text NOT NULL DEFAULT 'podcast';
        ALTER TABLE feeds ALTER COLUMN kind DROP DEFAULT;
        ALTER TABLE feeds ALTER COLUMN provider DROP NOT NULL;
        ALTER TABLE feeds ALTER COLUMN provider_podcast_id DROP NOT NULL;
        ALTER TABLE podcast_feed_runs RENAME TO feed_runs;
        ALTER TABLE feed_runs RENAME COLUMN podcast_id TO feed_id;
        ALTER TABLE podcast_library_imports RENAME TO library_feed_imports;
        ALTER TABLE library_podcast_subscriptions RENAME TO library_feed_subscriptions;
        ALTER TABLE library_feed_subscriptions RENAME COLUMN podcast_id TO feed_id;
        ALTER TABLE podcast_import_processed_episodes RENAME TO feed_import_processed_media;
        ALTER TABLE feeds RENAME COLUMN sync_run_id TO catchup_run_id;
        ALTER TABLE feeds ADD COLUMN head_run_id uuid UNIQUE REFERENCES feed_runs(id);
        ALTER TABLE feeds ADD COLUMN last_catchup_at timestamptz;
        ALTER TABLE feeds ADD COLUMN last_catchup_had_coverage_gaps boolean;
        ALTER TABLE feeds ADD COLUMN last_catchup_error_code text;
        ALTER TABLE feeds ADD COLUMN last_catchup_error_detail text;
        ALTER TABLE feed_runs ADD COLUMN purpose text;
        UPDATE feed_runs r SET purpose=CASE WHEN EXISTS
            (SELECT 1 FROM library_feed_imports i WHERE i.run_id=r.id)
            THEN 'import' ELSE 'catchup' END;
        ALTER TABLE feed_runs ALTER COLUMN purpose SET NOT NULL;
        UPDATE feeds SET last_catchup_at=last_checked_at,
            last_catchup_had_coverage_gaps=last_check_had_coverage_gaps,
            last_catchup_error_code=last_check_error_code,
            last_catchup_error_detail=last_check_error_detail,
            last_checked_at=NULL,last_check_had_coverage_gaps=NULL,
            last_check_error_code=NULL,last_check_error_detail=NULL,
            consecutive_sync_failures=0,next_sync_at=now();

        CREATE TABLE feed_url_aliases (
            url text PRIMARY KEY, feed_id uuid NOT NULL REFERENCES feeds(id)
        );
        CREATE INDEX ix_feed_url_aliases_feed ON feed_url_aliases(feed_id);
        CREATE TABLE feed_catalog_access (
            feed_id uuid NOT NULL REFERENCES feeds(id),
            user_id uuid NOT NULL REFERENCES users(id),
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(feed_id,user_id)
        );
        CREATE TABLE feed_entries (
            id uuid PRIMARY KEY,feed_id uuid NOT NULL REFERENCES feeds(id),
            media_id uuid NOT NULL REFERENCES media(id),entry_url text,
            published_at timestamptz,published_on date,
            publication_evidence text NOT NULL,publisher_updated_at timestamptz,
            first_seen_at timestamptz NOT NULL DEFAULT now(),source_fingerprint text,
            UNIQUE(feed_id,id)
        );
        CREATE INDEX ix_feed_entries_media ON feed_entries(media_id);
        CREATE INDEX ix_feed_entries_source_order ON feed_entries(feed_id,published_at DESC,id);
        INSERT INTO feed_entries(id,feed_id,media_id,published_at,publication_evidence,
                                 first_seen_at,source_fingerprint)
        SELECT media_id,podcast_id,media_id,published_at,'unverified',created_at,
               rss_metadata_fingerprint FROM podcast_episodes;
        -- The old episode writer copied retrieval feed URLs into public media metadata.
        -- Source credentials remain on feeds; later observations supply real permalinks.
        UPDATE media m SET canonical_source_url=NULL
        FROM podcast_episodes episode WHERE episode.media_id=m.id;
        ALTER TABLE podcast_episode_identities DROP CONSTRAINT fk_podcast_episode_identities_episode;
        ALTER TABLE podcast_episode_identities RENAME TO feed_entry_identities;
        ALTER TABLE feed_entry_identities RENAME COLUMN podcast_id TO feed_id;
        ALTER TABLE feed_entry_identities RENAME COLUMN episode_media_id TO entry_id;
        ALTER TABLE feed_entry_identities ADD CONSTRAINT fk_feed_entry_identity_entry
            FOREIGN KEY(feed_id,entry_id) REFERENCES feed_entries(feed_id,id);
        ALTER TABLE podcast_episodes DROP CONSTRAINT uq_podcast_episodes_podcast_media;
        ALTER TABLE podcast_episodes DROP CONSTRAINT podcast_episodes_podcast_id_fkey;
        ALTER TABLE podcast_episodes DROP COLUMN podcast_id;
        ALTER TABLE podcast_episodes DROP COLUMN published_at;
        ALTER TABLE podcast_episodes DROP COLUMN rss_metadata_fingerprint;

        CREATE TABLE viewer_media_discoveries (
            user_id uuid NOT NULL REFERENCES users(id),media_id uuid NOT NULL REFERENCES media(id),
            first_discovered_at timestamptz,origin text NOT NULL,manually_saved boolean NOT NULL,
            last_manually_saved_at timestamptz,
            PRIMARY KEY(user_id,media_id)
        );
        CREATE INDEX ix_viewer_media_discoveries_window
            ON viewer_media_discoveries(user_id,first_discovered_at);
        INSERT INTO viewer_media_discoveries(user_id,media_id,origin,manually_saved)
        SELECT DISTINCT membership.user_id,entry.media_id,'existing',false
        FROM library_entries entry JOIN libraries library ON library.id=entry.library_id
        JOIN memberships membership ON membership.library_id=library.id
        WHERE library.system_key IS NULL;

        ALTER TABLE reader_publications ADD COLUMN source_attempt_id uuid REFERENCES media_source_attempts(id);
        ALTER TABLE reader_publications ADD COLUMN content_extent text NOT NULL DEFAULT 'unknown';
        ALTER TABLE reader_publications ADD COLUMN publisher_published_at timestamptz;
        ALTER TABLE reader_publications ADD COLUMN publisher_published_on date;
        UPDATE reader_publications p SET content_extent='complete'
        FROM media m WHERE m.id=p.media_id AND (
            m.kind IN ('pdf','epub') OR (m.kind='web_article' AND NOT EXISTS (
                SELECT 1 FROM x_article_sources x WHERE x.media_id=m.id
            ) AND EXISTS (
                SELECT 1 FROM media_source_attempts a WHERE a.media_id=m.id AND a.status='succeeded'
                AND a.source_type IN ('generic_web_url','browser_article_capture','email_message')
            ))
        );
        UPDATE reader_publications p SET content_extent=
            CASE WHEN x.completeness='incomplete' THEN 'excerpt' ELSE 'unknown' END
        FROM x_article_sources x WHERE x.media_id=p.media_id;
        ALTER TABLE media_source_attempts DROP CONSTRAINT ck_media_source_attempts_source_type;

        CREATE TABLE feed_opml_imports (
            id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),
            expected_removal_revision bigint NOT NULL,attempt_version bigint NOT NULL DEFAULT 1,
            current_job_id uuid REFERENCES background_jobs(id),state text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_feed_opml_imports_user ON feed_opml_imports(user_id,created_at DESC,id);
        CREATE TABLE feed_opml_import_items (
            batch_id uuid NOT NULL REFERENCES feed_opml_imports(id),ordinal integer NOT NULL,
            id uuid NOT NULL UNIQUE,url text NOT NULL,selected_kind text,
            library_id uuid NOT NULL,subscription_id uuid NOT NULL,
            initial_import_id uuid NOT NULL,feed_id uuid REFERENCES feeds(id),
            admitted_subscription_id uuid,admitted_import_id uuid,
            state text NOT NULL,error_code text,error_detail text,retryable boolean NOT NULL DEFAULT false,
            PRIMARY KEY(batch_id,ordinal)
        );

        ALTER TABLE suggestion_feeds ADD COLUMN mode text NOT NULL DEFAULT 'suggestions';
        ALTER TABLE suggestion_feeds ALTER COLUMN mode DROP DEFAULT;
        DROP INDEX uq_suggestion_feeds_lectern;
        CREATE UNIQUE INDEX uq_suggestion_feeds_account ON suggestion_feeds(user_id,mode)
            WHERE library_id IS NULL;
        ALTER TABLE suggestion_shortlists ADD COLUMN edition_date date;
        ALTER TABLE suggestion_shortlists ADD COLUMN time_zone text;
        ALTER TABLE suggestion_shortlists ADD COLUMN window_start timestamptz;
        ALTER TABLE suggestion_shortlists ADD COLUMN window_end timestamptz;
        ALTER TABLE suggestion_shortlists ADD COLUMN coverage jsonb;

        UPDATE background_jobs SET kind='feed_page',
            dedupe_key=replace(dedupe_key,'podcast-feed:','feed:') WHERE kind='podcast_feed_page';
        UPDATE background_jobs SET kind='feed_refresh_due_job',
            dedupe_key=replace(dedupe_key,'podcast_refresh_due_job','feed_refresh_due_job')
            WHERE kind='podcast_refresh_due_job';
    """)
    for url, feed_id in aliases.items():
        db.execute(
            sa.text("INSERT INTO feed_url_aliases(url,feed_id) VALUES(:url,:id)"),
            {"url": url, "id": feed_id},
        )
    schemes = ",".join(
        f"'{scheme}'"
        for scheme in (
            "media",
            "library",
            "evidence_span",
            "content_chunk",
            "highlight",
            "page",
            "note_block",
            "fragment",
            "conversation",
            "message",
            "oracle_reading",
            "oracle_passage_anchor",
            "external_snapshot",
            "contributor",
            "podcast",
            "feed",
            "reader_apparatus_item",
            "passage_anchor",
        )
    )
    for table, column in (
        ("resource_edges", "source_scheme"),
        ("resource_edges", "target_scheme"),
        ("resource_versions", "resource_scheme"),
        ("resource_view_states", "surface_scheme"),
        ("resource_view_states", "target_scheme"),
    ):
        name = f"ck_{table}_{column}"
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"{column} IN ({schemes})")
    for row in db.execute(
        sa.text("""SELECT id,result FROM tool_calls
        WHERE tool_id='nexus.library.add' AND result->>'type'='Success'""")
    ):
        converted = _library_add_result(row.result, row.id)
        if converted is row.result:
            continue
        db.execute(
            sa.text("UPDATE tool_calls SET result=CAST(:result AS jsonb) WHERE id=:id"),
            {"id": row.id, "result": json.dumps(converted)},
        )


def downgrade() -> None:
    raise RuntimeError(
        "0338 is a hard cutover; restore the matched backup and binaries"
    )
