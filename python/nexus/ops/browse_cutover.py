"""Stopped-world Podcast persistence maintenance for Browse cutover 0201/0202."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory, transaction
from nexus.ids import new_uuid7
from nexus.jobs.queue import enqueue_job, lock_jobs_for_payload
from nexus.services.podcasts.backfill import (
    cursor_digest,
    enqueue_backfill_step_in_current_transaction,
)
from nexus.services.podcasts.episode_identity import EpisodeAlias
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url


class EpisodeIdentityRemediation(BaseModel):
    episode_media_id: UUID = Field(alias="episodeMediaId")
    scheme: Literal["PodcastIndex", "RssGuid", "RssEnclosure"]
    value: str = Field(min_length=1)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class SetOrigin(BaseModel):
    action: Literal["SetOrigin"]
    media_id: UUID = Field(alias="mediaId")
    origin: Literal["Publisher", "Imported", "Generated"]

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ClearTranscript(BaseModel):
    action: Literal["ClearTranscript"]
    media_id: UUID = Field(alias="mediaId")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


TranscriptRemediation = TypeAdapter(
    list[SetOrigin | ClearTranscript],
    config=ConfigDict(extra="forbid"),
)
IdentityRemediation = TypeAdapter(
    list[EpisodeIdentityRemediation],
    config=ConfigDict(extra="forbid"),
)


class Manifest(BaseModel):
    episode_identities: list[EpisodeIdentityRemediation] = Field(default_factory=list)
    transcripts: list[SetOrigin | ClearTranscript] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


def _stable_hash(value: object) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def _automatic_aliases(row: Mapping[str, Any]) -> tuple[EpisodeAlias, ...]:
    aliases: set[EpisodeAlias] = set()
    # Legacy ``provider_episode_id`` was also populated by RSS ingest. Neither
    # its shape nor Podcast/Media provider labels prove Podcast Index episode
    # provenance, so the maintenance command never infers this alias.
    guid = str(row["guid"] or "").strip()
    if guid:
        aliases.add(EpisodeAlias("RssGuid", guid))
    enclosure = str(row["external_playback_url"] or "").strip()
    if enclosure:
        try:
            validate_requested_url(enclosure)
        except Exception:
            pass
        else:
            aliases.add(EpisodeAlias("RssEnclosure", normalize_url_for_display(enclosure)))
    return tuple(sorted(aliases))


def _episode_rows(db: Session) -> list[Any]:
    return list(
        db.execute(
            text(
                """
                SELECT
                    episode.podcast_id,
                    episode.media_id,
                    episode.provider_episode_id,
                    episode.guid,
                    media.external_playback_url,
                    podcast.provider AS podcast_provider
                FROM podcast_episodes episode
                JOIN media ON media.id = episode.media_id
                JOIN podcasts podcast ON podcast.id = episode.podcast_id
                ORDER BY episode.podcast_id, episode.media_id
                """
            )
        ).mappings()
    )


def _table_exists(db: Session, table_name: str) -> bool:
    return bool(
        db.scalar(
            text("SELECT to_regclass(:table_name) IS NOT NULL"),
            {"table_name": f"public.{table_name}"},
        )
    )


def _column_exists(db: Session, table_name: str, column_name: str) -> bool:
    return bool(
        db.scalar(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = :table_name
                      AND column_name = :column_name
                )
                """
            ),
            {"table_name": table_name, "column_name": column_name},
        )
    )


def _schema_phase(db: Session) -> Literal["Legacy", "Prepared", "Finalized"]:
    """Identify the three exact schemas in the stopped-world sequence."""
    prepared_facts = (
        _column_exists(db, "podcast_subscriptions", "id"),
        _table_exists(db, "podcast_episode_identities"),
        _table_exists(db, "podcast_subscription_backfills"),
        _column_exists(db, "media_transcript_states", "transcript_origin"),
    )
    legacy_facts = (
        _column_exists(db, "podcast_subscriptions", "status"),
        _table_exists(db, "podcast_subscription_libraries"),
        _column_exists(db, "podcast_episodes", "provider_episode_id"),
        _column_exists(db, "podcast_episodes", "guid"),
        _column_exists(db, "podcast_episodes", "fallback_identity"),
    )
    if not any(prepared_facts) and all(legacy_facts):
        return "Legacy"
    if all(prepared_facts) and all(legacy_facts):
        return "Prepared"
    if all(prepared_facts) and not any(legacy_facts):
        return "Finalized"
    raise RuntimeError(
        "Browse cutover schema is between supported phases; restore the paired "
        "database or finish the current migration revision before continuing"
    )


def preflight(db: Session) -> dict[str, Any]:
    schema_phase = _schema_phase(db)
    if schema_phase == "Finalized":
        raise RuntimeError("Browse cutover preflight must run before revision 0202")
    episodes = _episode_rows(db)
    classified: dict[tuple[UUID, UUID], set[EpisodeAlias]] = {
        (UUID(str(row["podcast_id"])), UUID(str(row["media_id"]))): set(_automatic_aliases(row))
        for row in episodes
    }
    if schema_phase != "Legacy":
        for row in db.execute(
            text(
                """
                SELECT podcast_id, episode_media_id, scheme, value
                FROM podcast_episode_identities
                """
            )
        ).mappings():
            key = (
                UUID(str(row["podcast_id"])),
                UUID(str(row["episode_media_id"])),
            )
            classified.setdefault(key, set()).add(EpisodeAlias(row["scheme"], str(row["value"])))
    owners: dict[tuple[UUID, EpisodeAlias], list[UUID]] = {}
    for (podcast_id, media_id), aliases in classified.items():
        for alias in aliases:
            owners.setdefault((podcast_id, alias), []).append(media_id)
    identity_collisions = sorted(
        (
            {
                "podcastId": str(podcast_id),
                "scheme": alias.scheme,
                "valueHash": hashlib.sha256(alias.value.encode()).hexdigest(),
                "mediaIds": [str(value) for value in sorted(set(media_ids))],
            }
            for (podcast_id, alias), media_ids in owners.items()
            if len(set(media_ids)) > 1
        ),
        key=lambda row: (row["podcastId"], row["scheme"], row["valueHash"]),
    )
    unresolved_episodes = sorted(
        (
            {"podcastId": str(podcast_id), "mediaId": str(media_id)}
            for (podcast_id, media_id), aliases in classified.items()
            if not aliases
        ),
        key=lambda row: (row["podcastId"], row["mediaId"]),
    )
    transcript_origin_predicate = (
        "AND state.transcript_origin IS NULL" if schema_phase == "Prepared" else ""
    )
    ambiguous_transcripts = list(
        db.execute(
            text(
                f"""
                SELECT state.media_id
                FROM media_transcript_states state
                LEFT JOIN podcast_episodes episode ON episode.media_id = state.media_id
                WHERE state.transcript_state IN ('ready', 'partial')
                  {transcript_origin_predicate}
                  AND NOT (
                    state.last_request_reason = 'rss_feed'
                    AND episode.media_id IS NOT NULL
                  )
                ORDER BY state.media_id
                """
            )
        ).scalars()
    )
    counts = dict(
        db.execute(
            text(
                """
                SELECT
                    (
                        SELECT count(*) FROM podcast_subscriptions
                        WHERE status = 'active'
                    ) AS active_subscriptions,
                    (
                        SELECT count(*) FROM podcast_subscriptions
                        WHERE status <> 'active'
                    ) AS inactive_subscriptions,
                    (
                        SELECT count(*) FROM podcast_subscription_libraries
                    ) AS legacy_placements,
                    (
                        SELECT count(*)
                        FROM podcast_subscription_libraries legacy
                        JOIN podcast_subscriptions subscription
                          ON subscription.user_id = legacy.subscription_user_id
                         AND subscription.podcast_id = legacy.subscription_podcast_id
                        WHERE subscription.status = 'active'
                    ) AS active_legacy_placements,
                    (
                        SELECT count(*)
                        FROM podcast_subscription_libraries legacy
                        JOIN podcast_subscriptions subscription
                          ON subscription.user_id = legacy.subscription_user_id
                         AND subscription.podcast_id = legacy.subscription_podcast_id
                        WHERE subscription.status <> 'active'
                    ) AS inactive_legacy_placements,
                    (
                        SELECT count(*)
                        FROM podcast_subscription_libraries legacy
                        LEFT JOIN podcast_subscriptions subscription
                          ON subscription.user_id = legacy.subscription_user_id
                         AND subscription.podcast_id = legacy.subscription_podcast_id
                        WHERE subscription.user_id IS NULL
                    ) AS orphan_legacy_placements,
                    (
                        SELECT count(*) FROM library_entries
                        WHERE podcast_id IS NOT NULL
                    ) AS current_podcast_placements,
                    (
                        SELECT count(*)
                        FROM library_entries entry
                        JOIN libraries library ON library.id = entry.library_id
                        WHERE entry.podcast_id IS NOT NULL
                          AND library.is_default
                    ) AS default_podcast_placements,
                    (
                        SELECT count(*)
                        FROM library_entries entry
                        JOIN libraries library ON library.id = entry.library_id
                        WHERE entry.podcast_id IS NOT NULL
                          AND library.system_key IS NOT NULL
                    ) AS system_podcast_placements,
                    (
                        SELECT count(*)
                        FROM library_entries parent
                        WHERE parent.podcast_id IS NOT NULL
                          AND EXISTS (
                              SELECT 1
                              FROM library_entries child
                              JOIN podcast_episodes episode
                                ON episode.media_id = child.media_id
                              WHERE child.library_id = parent.library_id
                                AND episode.podcast_id = parent.podcast_id
                          )
                    ) AS parent_child_collisions,
                    (
                        SELECT count(*)
                        FROM libraries library
                        WHERE library.is_default
                    ) AS default_destinations,
                    (
                        SELECT count(*)
                        FROM libraries library
                        WHERE library.system_key IS NOT NULL
                    ) AS system_destinations,
                    (
                        SELECT count(*) FROM media_transcript_states
                        WHERE transcript_state IN ('ready', 'partial')
                    ) AS ready_transcripts
                """
            )
        )
        .mappings()
        .one()
    )
    inactive_placement_rows = [
        {
            "userId": str(row["user_id"]),
            "podcastId": str(row["podcast_id"]),
            "libraryId": str(row["library_id"]),
            "source": str(row["source"]),
        }
        for row in db.execute(
            text(
                """
                SELECT
                    legacy.subscription_user_id AS user_id,
                    legacy.subscription_podcast_id AS podcast_id,
                    legacy.library_id,
                    'podcast_subscription_libraries'::text AS source
                FROM podcast_subscription_libraries legacy
                JOIN podcast_subscriptions subscription
                  ON subscription.user_id = legacy.subscription_user_id
                 AND subscription.podcast_id = legacy.subscription_podcast_id
                WHERE subscription.status <> 'active'
                UNION ALL
                SELECT
                    membership.user_id,
                    entry.podcast_id,
                    entry.library_id,
                    'library_entries'::text AS source
                FROM library_entries entry
                JOIN memberships membership
                  ON membership.library_id = entry.library_id
                WHERE entry.podcast_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM podcast_subscriptions subscription
                      WHERE subscription.user_id = membership.user_id
                        AND subscription.podcast_id = entry.podcast_id
                        AND subscription.status <> 'active'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM memberships active_membership
                      JOIN podcast_subscriptions active_subscription
                        ON active_subscription.user_id = active_membership.user_id
                       AND active_subscription.podcast_id = entry.podcast_id
                       AND active_subscription.status = 'active'
                      WHERE active_membership.library_id = entry.library_id
                  )
                ORDER BY library_id, podcast_id, user_id, source
                """
            )
        ).mappings()
    ]
    placement_reconciliation_rows = [
        {
            "source": str(row["source"]),
            "sourceRowId": str(row["source_row_id"]),
            "userId": str(row["user_id"]) if row["user_id"] is not None else None,
            "podcastId": str(row["podcast_id"]),
            "libraryId": str(row["library_id"]),
            "action": str(row["action"]),
            "reason": str(row["reason"]),
        }
        for row in db.execute(
            text(
                """
                SELECT
                    'podcast_subscription_libraries'::text AS source,
                    concat_ws(
                        ':',
                        legacy.subscription_user_id,
                        legacy.subscription_podcast_id,
                        legacy.library_id
                    ) AS source_row_id,
                    legacy.subscription_user_id AS user_id,
                    legacy.subscription_podcast_id AS podcast_id,
                    legacy.library_id,
                    CASE
                        WHEN subscription.status = 'active'
                         AND membership.user_id IS NOT NULL
                         AND library.is_default = false
                         AND library.system_key IS NULL
                        THEN 'RetainNamedParent'
                        ELSE 'Discard'
                    END AS action,
                    CASE
                        WHEN subscription.user_id IS NULL THEN 'OrphanSubscription'
                        WHEN subscription.status <> 'active' THEN 'InactiveSubscription'
                        WHEN membership.user_id IS NULL THEN 'NoLibraryMembership'
                        WHEN library.is_default THEN 'DefaultDestination'
                        WHEN library.system_key IS NOT NULL THEN 'SystemDestination'
                        ELSE 'ActiveNamedPlacement'
                    END AS reason
                FROM podcast_subscription_libraries legacy
                LEFT JOIN podcast_subscriptions subscription
                  ON subscription.user_id = legacy.subscription_user_id
                 AND subscription.podcast_id = legacy.subscription_podcast_id
                LEFT JOIN memberships membership
                  ON membership.library_id = legacy.library_id
                 AND membership.user_id = legacy.subscription_user_id
                JOIN libraries library ON library.id = legacy.library_id
                UNION ALL
                SELECT
                    'library_entries'::text AS source,
                    entry.id::text AS source_row_id,
                    NULL::uuid AS user_id,
                    entry.podcast_id,
                    entry.library_id,
                    CASE
                        WHEN library.is_default = false
                         AND library.system_key IS NULL
                         AND EXISTS (
                             SELECT 1
                             FROM memberships membership
                             JOIN podcast_subscriptions subscription
                               ON subscription.user_id = membership.user_id
                              AND subscription.podcast_id = entry.podcast_id
                              AND subscription.status = 'active'
                             WHERE membership.library_id = entry.library_id
                         )
                        THEN 'RetainNamedParent'
                        ELSE 'Discard'
                    END AS action,
                    CASE
                        WHEN library.is_default THEN 'DefaultDestination'
                        WHEN library.system_key IS NOT NULL THEN 'SystemDestination'
                        WHEN NOT EXISTS (
                            SELECT 1
                            FROM memberships membership
                            JOIN podcast_subscriptions subscription
                              ON subscription.user_id = membership.user_id
                             AND subscription.podcast_id = entry.podcast_id
                             AND subscription.status = 'active'
                            WHERE membership.library_id = entry.library_id
                        ) THEN 'NoActiveSubscriberMember'
                        ELSE 'ActiveNamedPlacement'
                    END AS reason
                FROM library_entries entry
                JOIN libraries library ON library.id = entry.library_id
                WHERE entry.podcast_id IS NOT NULL
                ORDER BY source, library_id, podcast_id, source_row_id
                """
            )
        ).mappings()
    ]
    compacted_episode_rows = [
        {
            "entryId": str(row["entry_id"]),
            "mediaId": str(row["media_id"]),
            "podcastId": str(row["podcast_id"]),
            "libraryId": str(row["library_id"]),
        }
        for row in db.execute(
            text(
                """
                WITH active_placements AS (
                    SELECT
                        legacy.subscription_podcast_id AS podcast_id,
                        legacy.library_id
                    FROM podcast_subscription_libraries legacy
                    JOIN podcast_subscriptions subscription
                      ON subscription.user_id = legacy.subscription_user_id
                     AND subscription.podcast_id = legacy.subscription_podcast_id
                     AND subscription.status = 'active'
                    JOIN memberships membership
                      ON membership.library_id = legacy.library_id
                     AND membership.user_id = legacy.subscription_user_id
                    JOIN libraries library
                      ON library.id = legacy.library_id
                     AND library.is_default = false
                     AND library.system_key IS NULL
                    UNION
                    SELECT entry.podcast_id, entry.library_id
                    FROM library_entries entry
                    JOIN libraries library
                      ON library.id = entry.library_id
                     AND library.is_default = false
                     AND library.system_key IS NULL
                    JOIN memberships membership
                      ON membership.library_id = entry.library_id
                    JOIN podcast_subscriptions subscription
                      ON subscription.user_id = membership.user_id
                     AND subscription.podcast_id = entry.podcast_id
                     AND subscription.status = 'active'
                    WHERE entry.podcast_id IS NOT NULL
                )
                SELECT
                    child.id AS entry_id,
                    child.media_id,
                    episode.podcast_id,
                    child.library_id
                FROM library_entries child
                JOIN podcast_episodes episode ON episode.media_id = child.media_id
                JOIN active_placements active
                  ON active.library_id = child.library_id
                 AND active.podcast_id = episode.podcast_id
                ORDER BY child.library_id, episode.podcast_id, child.id
                """
            )
        ).mappings()
    ]
    default_episode_ensures = [
        {
            "userId": str(row["user_id"]),
            "podcastId": str(row["podcast_id"]),
            "libraryId": str(row["library_id"]),
            "mediaId": str(row["media_id"]),
        }
        for row in db.execute(
            text(
                """
                SELECT DISTINCT
                    subscription.user_id,
                    subscription.podcast_id,
                    library.id AS library_id,
                    episode.media_id
                FROM podcast_subscriptions subscription
                JOIN memberships membership
                  ON membership.user_id = subscription.user_id
                JOIN libraries library
                  ON library.id = membership.library_id
                 AND library.is_default = true
                JOIN podcast_episodes episode
                  ON episode.podcast_id = subscription.podcast_id
                WHERE subscription.status = 'active'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM library_entries existing
                      WHERE existing.library_id = library.id
                        AND existing.media_id = episode.media_id
                  )
                ORDER BY library_id, podcast_id, media_id, user_id
                """
            )
        ).mappings()
    ]
    affected_library_entry_rows = [
        {
            "entryId": str(row["entry_id"]),
            "libraryId": str(row["library_id"]),
            "position": int(row["position"]),
        }
        for row in db.execute(
            text(
                """
                WITH affected_libraries AS (
                    SELECT DISTINCT library_id
                    FROM library_entries
                    WHERE podcast_id IS NOT NULL
                    UNION
                    SELECT legacy.library_id
                    FROM podcast_subscription_libraries legacy
                    JOIN podcast_subscriptions subscription
                      ON subscription.user_id = legacy.subscription_user_id
                     AND subscription.podcast_id = legacy.subscription_podcast_id
                     AND subscription.status = 'active'
                    JOIN memberships membership
                      ON membership.library_id = legacy.library_id
                     AND membership.user_id = legacy.subscription_user_id
                    JOIN libraries library
                      ON library.id = legacy.library_id
                     AND library.is_default = false
                     AND library.system_key IS NULL
                    UNION
                    SELECT library.id
                    FROM podcast_subscriptions subscription
                    JOIN memberships membership
                      ON membership.user_id = subscription.user_id
                    JOIN libraries library
                      ON library.id = membership.library_id
                     AND library.is_default = true
                    WHERE subscription.status = 'active'
                )
                SELECT
                    entry.id AS entry_id,
                    entry.library_id,
                    entry.position
                FROM library_entries entry
                JOIN affected_libraries affected
                  ON affected.library_id = entry.library_id
                ORDER BY entry.library_id, entry.position, entry.id
                """
            )
        ).mappings()
    ]
    report = {
        "schemaPhase": schema_phase,
        "counts": counts,
        "unresolvedEpisodes": unresolved_episodes,
        "identityCollisions": identity_collisions,
        "ambiguousTranscripts": [str(value) for value in ambiguous_transcripts],
        "identityRemediation": [
            {
                "episodeMediaId": str(item["mediaId"]),
                "scheme": None,
                "value": None,
            }
            for item in unresolved_episodes
        ],
        "transcriptOriginRemediation": [
            {
                "action": "SetOrigin|ClearTranscript",
                "mediaId": str(media_id),
            }
            for media_id in ambiguous_transcripts
        ],
        "inactivePlacementRows": inactive_placement_rows,
        "placementReconciliationRows": placement_reconciliation_rows,
        "compactedEpisodePlacementRows": compacted_episode_rows,
        "defaultEpisodePlacementEnsures": default_episode_ensures,
        "affectedLibraryEntryRows": affected_library_entry_rows,
    }
    return {**report, "reportHash": _stable_hash(report)}


def _normalized_manifest_alias(item: EpisodeIdentityRemediation) -> EpisodeAlias:
    value = item.value.strip()
    if not value:
        raise RuntimeError(f"Blank episode identity for {item.episode_media_id}")
    if item.scheme == "RssEnclosure":
        validate_requested_url(value)
        value = normalize_url_for_display(value)
    return EpisodeAlias(item.scheme, value)


def _validated_episode_alias_graph(
    db: Session,
    manifest: Manifest,
) -> dict[tuple[UUID, UUID], tuple[EpisodeAlias, ...]]:
    rows = _episode_rows(db)
    episode_keys = {
        UUID(str(row["media_id"])): (
            UUID(str(row["podcast_id"])),
            UUID(str(row["media_id"])),
        )
        for row in rows
    }
    desired: dict[tuple[UUID, UUID], set[EpisodeAlias]] = {
        (UUID(str(row["podcast_id"])), UUID(str(row["media_id"]))): set(_automatic_aliases(row))
        for row in rows
    }
    for item in manifest.episode_identities:
        key = episode_keys.get(item.episode_media_id)
        if key is None:
            raise RuntimeError(
                f"Identity remediation names unknown episode Media {item.episode_media_id}"
            )
        desired[key].add(_normalized_manifest_alias(item))

    for row in db.execute(
        text(
            """
            SELECT podcast_id, episode_media_id, scheme, value
            FROM podcast_episode_identities
            ORDER BY podcast_id, episode_media_id, scheme, value
            """
        )
    ).mappings():
        key = (
            UUID(str(row["podcast_id"])),
            UUID(str(row["episode_media_id"])),
        )
        if key not in desired:
            raise RuntimeError("Stored episode alias points outside the episode relation")
        desired[key].add(EpisodeAlias(row["scheme"], str(row["value"])))

    owners: dict[tuple[UUID, EpisodeAlias], UUID] = {}
    for (podcast_id, media_id), aliases in desired.items():
        if not aliases:
            raise RuntimeError(f"Missing episode identity remediation for {media_id}")
        strong_schemes: set[str] = set()
        for alias in aliases:
            if alias.scheme in {"PodcastIndex", "RssGuid"} and alias.scheme in strong_schemes:
                raise RuntimeError(f"Episode {media_id} has multiple {alias.scheme} identities")
            if alias.scheme in {"PodcastIndex", "RssGuid"}:
                strong_schemes.add(alias.scheme)
            owner_key = (podcast_id, alias)
            prior = owners.get(owner_key)
            if prior is not None and prior != media_id:
                raise RuntimeError(
                    f"Episode alias {alias.scheme} cross-links {prior} and {media_id}"
                )
            owners[owner_key] = media_id
    return {key: tuple(sorted(aliases)) for key, aliases in desired.items()}


def apply(db: Session, manifest: Manifest) -> dict[str, Any]:
    if _schema_phase(db) != "Prepared":
        raise RuntimeError("Browse cutover apply requires revision 0201")
    before = preflight(db)
    aliases_by_episode = _validated_episode_alias_graph(db, manifest)
    transcript_remediations: dict[UUID, SetOrigin | ClearTranscript] = {}
    for item in manifest.transcripts:
        if item.media_id in transcript_remediations:
            raise RuntimeError(f"Duplicate transcript remediation for {item.media_id}")
        transcript_remediations[item.media_id] = item
    with transaction(db):
        for subscription_id in db.execute(
            text("SELECT user_id, podcast_id FROM podcast_subscriptions WHERE id IS NULL")
        ).fetchall():
            db.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET id = :id
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {
                    "id": new_uuid7(),
                    "user_id": subscription_id[0],
                    "podcast_id": subscription_id[1],
                },
            )

        for key, aliases in aliases_by_episode.items():
            for alias in aliases:
                db.execute(
                    text(
                        """
                        INSERT INTO podcast_episode_identities (
                            id, podcast_id, scheme, value, episode_media_id
                        )
                        SELECT :id, :podcast_id, :scheme, :value, :media_id
                        WHERE NOT EXISTS (
                            SELECT 1
                            FROM podcast_episode_identities
                            WHERE podcast_id = :podcast_id
                              AND scheme = :scheme
                              AND value = :value
                              AND episode_media_id = :media_id
                        )
                        """
                    ),
                    {
                        "id": new_uuid7(),
                        "podcast_id": key[0],
                        "scheme": alias.scheme,
                        "value": alias.value,
                        "media_id": key[1],
                    },
                )
        _assert_episode_alias_graph(db, aliases_by_episode)

        placement_report = _reconcile_legacy_placements(db)
        db.execute(text("DELETE FROM podcast_subscriptions WHERE status <> 'active'"))
        _classify_transcript_origins(db, transcript_remediations)
        retained = db.execute(
            text(
                """
                SELECT id
                FROM podcast_subscriptions
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM podcast_subscription_backfills backfill
                    WHERE backfill.subscription_id = podcast_subscriptions.id
                )
                ORDER BY id
                """
            )
        ).scalars()
        for subscription_id in retained:
            db.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_backfills (
                        id, subscription_id, cutoff_at, step_no, cursor,
                        processed_count, added_count, created_at, updated_at
                    )
                    VALUES (
                        :id, :subscription_id, transaction_timestamp(), 0, NULL,
                        0, 0, now(), now()
                    )
                    """
                ),
                {"id": new_uuid7(), "subscription_id": subscription_id},
            )
    after = preflight(db)
    report = {
        "beforeHash": before["reportHash"],
        "afterHash": after["reportHash"],
        "manifestHash": _stable_hash(manifest.model_dump(mode="json", by_alias=True)),
        "placementReconciliation": placement_report,
        "destructiveTranscriptClears": [
            str(item.media_id) for item in manifest.transcripts if isinstance(item, ClearTranscript)
        ],
        "after": after,
    }
    return {**report, "reportHash": _stable_hash(report)}


def _assert_episode_alias_graph(
    db: Session,
    expected: Mapping[tuple[UUID, UUID], tuple[EpisodeAlias, ...]],
) -> None:
    actual = {
        (
            UUID(str(row["podcast_id"])),
            UUID(str(row["episode_media_id"])),
        ): set()
        for row in db.execute(
            text(
                """
                SELECT DISTINCT podcast_id, episode_media_id
                FROM podcast_episode_identities
                """
            )
        ).mappings()
    }
    for row in db.execute(
        text(
            """
            SELECT podcast_id, episode_media_id, scheme, value
            FROM podcast_episode_identities
            """
        )
    ).mappings():
        actual[
            (
                UUID(str(row["podcast_id"])),
                UUID(str(row["episode_media_id"])),
            )
        ].add(EpisodeAlias(row["scheme"], str(row["value"])))
    expected_sets = {key: set(aliases) for key, aliases in expected.items()}
    if actual != expected_sets:
        raise RuntimeError("Persisted episode alias graph differs from validated graph")


def _reconcile_legacy_placements(db: Session) -> dict[str, int]:
    """Reconcile the active union into one named parent fact and Default children."""
    legacy_inactive = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM podcast_subscription_libraries legacy
                LEFT JOIN podcast_subscriptions subscription
                  ON subscription.user_id = legacy.subscription_user_id
                 AND subscription.podcast_id = legacy.subscription_podcast_id
                WHERE subscription.user_id IS NULL
                   OR subscription.status <> 'active'
                """
            )
        )
        or 0
    )
    db.execute(
        text(
            """
            CREATE TEMP TABLE browse_active_podcast_placements (
                user_id uuid NOT NULL,
                podcast_id uuid NOT NULL,
                library_id uuid NOT NULL,
                PRIMARY KEY (user_id, podcast_id, library_id)
            ) ON COMMIT DROP
            """
        )
    )
    db.execute(
        text(
            """
            INSERT INTO browse_active_podcast_placements (
                user_id, podcast_id, library_id
            )
            SELECT
                legacy.subscription_user_id,
                legacy.subscription_podcast_id,
                legacy.library_id
            FROM podcast_subscription_libraries legacy
            JOIN podcast_subscriptions subscription
              ON subscription.user_id = legacy.subscription_user_id
             AND subscription.podcast_id = legacy.subscription_podcast_id
             AND subscription.status = 'active'
            JOIN memberships membership
              ON membership.library_id = legacy.library_id
             AND membership.user_id = legacy.subscription_user_id
            JOIN libraries library
              ON library.id = legacy.library_id
             AND library.is_default = false
             AND library.system_key IS NULL
            """
        )
    )
    db.execute(
        text(
            """
            INSERT INTO browse_active_podcast_placements (
                user_id, podcast_id, library_id
            )
            SELECT
                membership.user_id,
                entry.podcast_id,
                entry.library_id
            FROM library_entries entry
            JOIN libraries library
              ON library.id = entry.library_id
             AND library.is_default = false
             AND library.system_key IS NULL
            JOIN memberships membership
              ON membership.library_id = entry.library_id
            JOIN podcast_subscriptions subscription
              ON subscription.user_id = membership.user_id
             AND subscription.podcast_id = entry.podcast_id
             AND subscription.status = 'active'
            WHERE entry.podcast_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM browse_active_podcast_placements existing
                  WHERE existing.user_id = membership.user_id
                    AND existing.podcast_id = entry.podcast_id
                    AND existing.library_id = entry.library_id
              )
            """
        )
    )
    db.execute(
        text(
            """
            CREATE TEMP TABLE browse_affected_libraries (
                library_id uuid PRIMARY KEY
            ) ON COMMIT DROP
            """
        )
    )
    db.execute(
        text(
            """
            INSERT INTO browse_affected_libraries (library_id)
            SELECT DISTINCT library_id
            FROM library_entries
            WHERE podcast_id IS NOT NULL
            UNION
            SELECT DISTINCT library_id
            FROM browse_active_podcast_placements
            """
        )
    )
    discarded_current_result = cast(
        CursorResult[Any],
        db.execute(
            text(
                """
                DELETE FROM library_entries entry
                WHERE entry.podcast_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM browse_active_podcast_placements active
                      WHERE active.library_id = entry.library_id
                        AND active.podcast_id = entry.podcast_id
                  )
                RETURNING id
                """
            )
        ),
    )
    discarded_current = int(discarded_current_result.rowcount or 0)

    placements = list(
        db.execute(
            text(
                """
                SELECT DISTINCT library_id, podcast_id
                FROM browse_active_podcast_placements
                ORDER BY library_id, podcast_id
                """
            )
        ).mappings()
    )
    inserted_parents = 0
    for row in placements:
        params = {
            "podcast_id": row["podcast_id"],
            "library_id": row["library_id"],
        }
        earliest = db.scalar(
            text(
                """
                SELECT min(entry.position)
                FROM library_entries entry
                WHERE entry.library_id = :library_id
                  AND (
                      entry.podcast_id = :podcast_id
                      OR EXISTS (
                          SELECT 1
                          FROM podcast_episodes episode
                          WHERE episode.media_id = entry.media_id
                            AND episode.podcast_id = :podcast_id
                      )
                  )
                """
            ),
            params,
        )
        if earliest is None:
            earliest = db.scalar(
                text(
                    """
                    SELECT COALESCE(max(position), -1) + 1
                    FROM library_entries
                    WHERE library_id = :library_id
                    """
                ),
                params,
            )
        parent_ids = list(
            db.scalars(
                text(
                    """
                    SELECT id
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND podcast_id = :podcast_id
                    ORDER BY created_at, id
                    """
                ),
                params,
            )
        )
        if len(parent_ids) > 1:
            raise RuntimeError("Multiple Podcast parent placements remain for one named Library")
        parent_id = parent_ids[0] if parent_ids else None
        if parent_id is None:
            db.execute(
                text(
                    """
                    INSERT INTO library_entries (
                        library_id, media_id, podcast_id, position
                    )
                    VALUES (:library_id, NULL, :podcast_id, :position)
                    """
                ),
                {**params, "position": int(earliest or 0)},
            )
            inserted_parents += 1
        else:
            db.execute(
                text(
                    """
                    UPDATE library_entries
                    SET position = :position
                    WHERE id = :id
                    """
                ),
                {"id": parent_id, "position": int(earliest or 0)},
            )

    removed_children_result = cast(
        CursorResult[Any],
        db.execute(
            text(
                """
                DELETE FROM library_entries child
                USING podcast_episodes episode
                WHERE child.media_id = episode.media_id
                  AND EXISTS (
                      SELECT 1
                      FROM browse_active_podcast_placements active
                      WHERE active.library_id = child.library_id
                        AND active.podcast_id = episode.podcast_id
                  )
                RETURNING child.id
                """
            )
        ),
    )
    removed_children = int(removed_children_result.rowcount or 0)

    inserted_default_library_ids = list(
        db.execute(
            text(
                """
                WITH candidates AS (
                    SELECT DISTINCT
                        default_library.id AS library_id,
                        episode.media_id
                    FROM podcast_subscriptions subscription
                    JOIN memberships membership
                      ON membership.user_id = subscription.user_id
                    JOIN libraries default_library
                      ON default_library.id = membership.library_id
                     AND default_library.is_default = true
                    JOIN podcast_episodes episode
                      ON episode.podcast_id = subscription.podcast_id
                    WHERE subscription.status = 'active'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM library_entries existing
                          WHERE existing.library_id = default_library.id
                            AND existing.media_id = episode.media_id
                      )
                ),
                missing AS (
                    SELECT
                        candidates.library_id,
                        candidates.media_id,
                        row_number() OVER (
                            PARTITION BY candidates.library_id
                            ORDER BY candidates.media_id
                        ) AS ordinal
                    FROM candidates
                ),
                base AS (
                    SELECT
                        library_id,
                        COALESCE(max(position), -1) AS max_position
                    FROM library_entries
                    WHERE library_id IN (SELECT library_id FROM missing)
                    GROUP BY library_id
                )
                INSERT INTO library_entries (
                    library_id, media_id, podcast_id, position
                )
                SELECT
                    missing.library_id,
                    missing.media_id,
                    NULL,
                    COALESCE(base.max_position, -1) + missing.ordinal
                FROM missing
                LEFT JOIN base ON base.library_id = missing.library_id
                RETURNING library_id
                """
            )
        ).scalars()
    )
    if inserted_default_library_ids:
        db.execute(
            text(
                """
                INSERT INTO browse_affected_libraries (library_id)
                SELECT DISTINCT value
                FROM unnest(CAST(:library_ids AS uuid[])) AS value
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM browse_affected_libraries existing
                    WHERE existing.library_id = value
                )
                """
            ),
            {"library_ids": inserted_default_library_ids},
        )

    db.execute(
        text(
            """
            WITH ordered AS (
                SELECT
                    entry.id,
                    row_number() OVER (
                        PARTITION BY entry.library_id
                        ORDER BY entry.position, entry.created_at DESC, entry.id DESC
                    ) - 1 AS new_position
                FROM library_entries entry
                WHERE entry.library_id IN (
                    SELECT library_id FROM browse_affected_libraries
                )
            )
            UPDATE library_entries entry
            SET position = ordered.new_position
            FROM ordered
            WHERE entry.id = ordered.id
              AND entry.position <> ordered.new_position
            """
        )
    )
    remaining_collisions = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM library_entries parent
                WHERE parent.podcast_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM library_entries child
                      JOIN podcast_episodes episode
                        ON episode.media_id = child.media_id
                      WHERE child.library_id = parent.library_id
                        AND episode.podcast_id = parent.podcast_id
                  )
                """
            )
        )
        or 0
    )
    if remaining_collisions:
        raise RuntimeError("Podcast parent/child placement reconciliation is incomplete")
    return {
        "inactiveLegacyRowsDiscarded": legacy_inactive,
        "currentParentRowsDiscarded": discarded_current,
        "parentRowsInserted": inserted_parents,
        "namedChildRowsCompacted": removed_children,
        "defaultChildRowsInserted": len(inserted_default_library_ids),
    }


def _classify_transcript_origins(
    db: Session,
    remediations: Mapping[UUID, SetOrigin | ClearTranscript],
) -> None:
    ambiguous_ids = {
        UUID(str(value))
        for value in db.execute(
            text(
                """
                SELECT state.media_id
                FROM media_transcript_states state
                LEFT JOIN podcast_episodes episode ON episode.media_id = state.media_id
                WHERE state.transcript_state IN ('ready', 'partial')
                  AND state.transcript_origin IS NULL
                  AND NOT (
                    state.last_request_reason = 'rss_feed'
                    AND episode.media_id IS NOT NULL
                  )
                """
            )
        ).scalars()
    }
    remediation_ids = set(remediations)
    if remediation_ids != ambiguous_ids:
        missing = sorted(ambiguous_ids - remediation_ids)
        extra = sorted(remediation_ids - ambiguous_ids)
        raise RuntimeError(
            f"Transcript remediation must exactly cover ambiguity; missing={missing}, extra={extra}"
        )
    db.execute(
        text(
            """
            UPDATE media_transcript_states state
            SET transcript_origin = CASE
                WHEN state.last_request_reason = 'rss_feed'
                 AND EXISTS (
                    SELECT 1 FROM podcast_episodes
                    WHERE media_id = state.media_id
                 )
                THEN 'Publisher'
                ELSE transcript_origin
            END
            WHERE transcript_state IN ('ready', 'partial')
              AND transcript_origin IS NULL
            """
        )
    )
    for media_id, remediation in remediations.items():
        if isinstance(remediation, SetOrigin):
            updated = cast(
                CursorResult[Any],
                db.execute(
                    text(
                        """
                    UPDATE media_transcript_states
                    SET transcript_origin = :origin
                    WHERE media_id = :media_id
                      AND transcript_state IN ('ready', 'partial')
                    """
                    ),
                    {"media_id": media_id, "origin": remediation.origin},
                ),
            )
            if updated.rowcount != 1:
                raise RuntimeError(
                    f"Transcript remediation target is not Ready/Partial: {media_id}"
                )
            continue
        dependencies = (
            db.execute(
                text(
                    """
                WITH fragment_ids AS (
                    SELECT id FROM fragments WHERE media_id = :media_id
                )
                SELECT
                    EXISTS (
                        SELECT 1 FROM highlights
                        WHERE anchor_media_id = :media_id
                    ) AS highlights,
                    EXISTS (
                        SELECT 1 FROM resource_edges
                        WHERE (source_scheme = 'media' AND source_id = :media_id)
                           OR (target_scheme = 'media' AND target_id = :media_id)
                           OR (source_scheme = 'fragment' AND source_id IN (
                               SELECT id FROM fragment_ids
                           ))
                           OR (target_scheme = 'fragment' AND target_id IN (
                               SELECT id FROM fragment_ids
                           ))
                    ) AS graph,
                    EXISTS (
                        SELECT 1 FROM resource_view_states
                        WHERE (surface_scheme = 'media' AND surface_id = :media_id)
                           OR (target_scheme = 'media' AND target_id = :media_id)
                           OR (surface_scheme = 'fragment' AND surface_id IN (
                               SELECT id FROM fragment_ids
                           ))
                           OR (target_scheme = 'fragment' AND target_id IN (
                               SELECT id FROM fragment_ids
                           ))
                    ) AS view_state,
                    EXISTS (
                        SELECT 1 FROM passage_anchors
                        WHERE owner_scheme = 'media' AND owner_id = :media_id
                    ) AS passage_anchors,
                    EXISTS (
                        SELECT 1 FROM message_retrievals
                        WHERE media_id = :media_id
                    ) AS citations,
                    EXISTS (
                        SELECT 1 FROM document_embeds
                        WHERE fragment_id IN (SELECT id FROM fragment_ids)
                    ) AS document_embeds,
                    EXISTS (
                        SELECT 1 FROM content_blocks
                        WHERE owner_kind = 'media' AND owner_id = :media_id
                    ) OR EXISTS (
                        SELECT 1 FROM evidence_spans
                        WHERE owner_kind = 'media' AND owner_id = :media_id
                    ) OR EXISTS (
                        SELECT 1 FROM content_chunks
                        WHERE owner_kind = 'media' AND owner_id = :media_id
                    ) AS retrieval_index,
                    EXISTS (
                        SELECT 1 FROM reader_media_state
                        WHERE media_id = :media_id
                    ) OR EXISTS (
                        SELECT 1 FROM reader_engagement_states
                        WHERE media_id = :media_id
                    ) OR EXISTS (
                        SELECT 1 FROM podcast_listening_states
                        WHERE media_id = :media_id
                    ) AS progress
                """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        blocking = [name for name, present in dependencies.items() if bool(present)]
        if blocking:
            raise RuntimeError(f"Transcript {media_id} has dependent state: {', '.join(blocking)}")
        db.execute(
            text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        db.execute(
            text("DELETE FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        db.execute(
            text(
                """
                UPDATE media_transcript_states
                SET transcript_state = 'not_requested',
                    transcript_coverage = 'none',
                    semantic_status = 'none',
                    transcript_origin = NULL,
                    last_error_code = NULL,
                    updated_at = now()
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
    unresolved = db.scalar(
        text(
            """
            SELECT count(*)
            FROM media_transcript_states
            WHERE transcript_state IN ('ready', 'partial')
              AND transcript_origin IS NULL
            """
        )
    )
    if unresolved:
        raise RuntimeError(f"{unresolved} transcript origin remediations remain")


def enqueue(db: Session) -> dict[str, Any]:
    if _schema_phase(db) != "Finalized":
        raise RuntimeError("Browse cutover enqueue requires revision 0202")
    inserted_backfill = 0
    inserted_live = 0
    with transaction(db):
        backfills = db.execute(
            text(
                """
                SELECT id, step_no, cursor
                FROM podcast_subscription_backfills
                WHERE completed_at IS NULL
                  AND source_limited_at IS NULL
                  AND failed_at IS NULL
                ORDER BY id
                """
            )
        ).mappings()
        for row in backfills:
            cursor = cast(dict[str, object] | None, row["cursor"])
            expected = {
                "backfillId": str(row["id"]),
                "expectedStepNo": int(row["step_no"]),
                "expectedCursorDigest": cursor_digest(cursor),
            }
            jobs = lock_jobs_for_payload(
                db,
                kind="podcast_backfill_subscription",
                expected_payload_match=expected,
            )
            if any(job.status in {"pending", "running", "failed"} for job in jobs):
                continue
            current = (
                db.execute(
                    text(
                        """
                    SELECT step_no, cursor
                    FROM podcast_subscription_backfills
                    WHERE id = :backfill_id
                      AND completed_at IS NULL
                      AND source_limited_at IS NULL
                      AND failed_at IS NULL
                    FOR UPDATE
                    """
                    ),
                    {"backfill_id": row["id"]},
                )
                .mappings()
                .first()
            )
            if current is None:
                continue
            current_cursor = cast(dict[str, object] | None, current["cursor"])
            if (
                int(current["step_no"]) != int(row["step_no"])
                or cursor_digest(current_cursor) != expected["expectedCursorDigest"]
            ):
                raise RuntimeError("Backfill fence changed during stopped-world enqueue")
            inserted_backfill += int(
                enqueue_backfill_step_in_current_transaction(
                    db,
                    backfill_id=UUID(str(row["id"])),
                    step_no=int(row["step_no"]),
                    cursor=cursor,
                )
            )
        subscriptions = db.execute(
            text(
                """
                SELECT user_id, podcast_id
                FROM podcast_subscriptions
                ORDER BY id
                """
            )
        ).mappings()
        for row in subscriptions:
            expected = {
                "user_id": str(row["user_id"]),
                "podcast_id": str(row["podcast_id"]),
            }
            jobs = lock_jobs_for_payload(
                db,
                kind="podcast_sync_subscription_job",
                expected_payload_match=expected,
            )
            if any(job.status in {"pending", "running", "failed"} for job in jobs):
                continue
            current_subscription = db.scalar(
                text(
                    """
                    SELECT 1
                    FROM podcast_subscriptions
                    WHERE user_id = :user_id
                      AND podcast_id = :podcast_id
                    FOR UPDATE
                    """
                ),
                expected,
            )
            if current_subscription is None:
                continue
            enqueue_job(
                db,
                kind="podcast_sync_subscription_job",
                payload={**expected, "request_id": None},
                max_attempts=3,
            )
            inserted_live += 1
        pending_backfills = list(
            db.execute(
                text(
                    """
                    SELECT id, step_no, cursor
                    FROM podcast_subscription_backfills
                    WHERE completed_at IS NULL
                      AND source_limited_at IS NULL
                      AND failed_at IS NULL
                    """
                )
            ).mappings()
        )
        nonterminal_payloads = [
            cast(dict[str, object], payload)
            for payload in db.execute(
                text(
                    """
                    SELECT payload
                    FROM background_jobs
                    WHERE kind = 'podcast_backfill_subscription'
                      AND status NOT IN ('succeeded', 'dead')
                    """
                )
            ).scalars()
        ]
        for pending in pending_backfills:
            pending_cursor = cast(dict[str, object] | None, pending["cursor"])
            expected_payload = {
                "backfillId": str(pending["id"]),
                "expectedStepNo": int(pending["step_no"]),
                "expectedCursorDigest": cursor_digest(pending_cursor),
            }
            matching = [
                payload
                for payload in nonterminal_payloads
                if all(payload.get(key) == value for key, value in expected_payload.items())
            ]
            if len(matching) != 1:
                raise RuntimeError(
                    "Pending backfill does not have exactly one current nonterminal job"
                )
    report = {
        "backfillJobsInserted": inserted_backfill,
        "liveJobsInserted": inserted_live,
    }
    return {**report, "reportHash": _stable_hash(report)}


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.browse_cutover")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("preflight")
    apply_parser = subcommands.add_parser("apply")
    apply_parser.add_argument("--identity-map", required=True)
    apply_parser.add_argument("--transcript-origin-map", required=True)
    apply_parser.add_argument("--report", required=True)
    subcommands.add_parser("enqueue")
    args = parser.parse_args()
    db = get_session_factory()()
    try:
        if args.command == "preflight":
            result = preflight(db)
            db.rollback()
        elif args.command == "apply":
            identity_raw = json.loads(Path(args.identity_map).read_text())
            transcript_raw = json.loads(Path(args.transcript_origin_map).read_text())
            result = apply(
                db,
                Manifest(
                    episode_identities=IdentityRemediation.validate_python(identity_raw),
                    transcripts=TranscriptRemediation.validate_python(transcript_raw),
                ),
            )
            Path(args.report).write_text(
                json.dumps(result, sort_keys=True, indent=2, default=str) + "\n"
            )
        else:
            result = enqueue(db)
        print(json.dumps(result, sort_keys=True, indent=2, default=str))
    finally:
        db.close()


if __name__ == "__main__":
    main()
