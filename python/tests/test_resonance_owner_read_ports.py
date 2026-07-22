"""Integration coverage for the bounded public read ports Resonance composes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import (
    ConsumptionQueueItem,
    ContentChunk,
    ContentEmbedding,
    ContentIndexState,
    Contributor,
    ContributorCredit,
    LibraryEntry,
    Media,
    MediaKind,
    Podcast,
    PodcastEpisode,
    PodcastListeningState,
    PodcastSubscription,
    ProcessingStatus,
    ReaderEngagementState,
    UserMediaDeletion,
)
from nexus.ids import new_uuid7
from nexus.services import (
    contributor_credits,
    highlights,
    media,
    notes,
    semantic_chunks,
)
from nexus.services.consumption import service as consumption
from nexus.services.contributor_taxonomy import contributor_match_key
from nexus.services.podcasts import episodes, subscriptions_query
from nexus.services.resonance import service as resonance_service
from nexus.services.resource_graph import connection_summaries, resolve
from tests.factories import (
    add_media_to_library,
    create_searchable_media,
    create_test_highlight_note,
    create_test_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def _default_library(db: Session, viewer_id: UUID) -> UUID:
    library_id = get_user_default_library(db, viewer_id)
    assert library_id is not None, "bootstrapped user must have a Default library"
    return library_id


def test_consumption_relations_include_complete_membership_and_canonical_engagement(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    media_id = create_searchable_media(
        db_session, bootstrapped_user, title="Bounded consumption port"
    )
    activity_at = datetime(2026, 7, 20, 12, tzinfo=UTC)
    db_session.add(
        ReaderEngagementState(
            id=new_uuid7(),
            user_id=bootstrapped_user,
            media_id=media_id,
            last_engaged_at=activity_at,
            max_total_progression=0.4,
        )
    )
    db_session.add(
        ConsumptionQueueItem(
            user_id=bootstrapped_user,
            media_id=media_id,
            position=0,
            source="manual",
        )
    )
    db_session.commit()

    fact = (
        db_session.execute(
            text(
                f"""
                SELECT media_id, read_state, progress_fraction, last_engaged_at
                FROM ({consumption.engagement_fact_rows_sql()}) facts
                WHERE media_id = :media_id
                """
            ),
            {"viewer_id": bootstrapped_user, "media_id": media_id},
        )
        .mappings()
        .one()
    )
    assert fact["read_state"] == "InProgress"
    assert float(fact["progress_fraction"]) == pytest.approx(0.4)
    assert fact["last_engaged_at"] == activity_at

    queued = db_session.execute(
        text(
            f"""
            SELECT media_id
            FROM ({consumption.lectern_membership_rows_sql()}) membership
            """
        ),
        {"viewer_id": bootstrapped_user},
    ).scalars()
    assert list(queued) == [media_id]
    assert consumption.lectern_item_count(db_session, viewer_id=bootstrapped_user) == 1
    assert consumption.lectern_has_capacity(db_session, viewer_id=bootstrapped_user) is True
    recent = consumption.recent_engagement_anchor_facts(
        db_session, viewer_id=bootstrapped_user, limit=5
    )
    assert tuple((fact.media_id, fact.activity_at) for fact in recent) == ((media_id, activity_at),)


def test_anchor_and_graph_relations_normalize_one_hop_without_expansion(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Graph owner")
    highlight_id, note_block_id = create_test_highlight_note(
        db_session, bootstrapped_user, media_id, body="A recent exact note anchor"
    )
    page_id = db_session.execute(
        text(
            """
            SELECT source_id
            FROM resource_edges
            WHERE user_id = :viewer_id
              AND source_scheme = 'page'
              AND target_scheme = 'note_block'
              AND target_id = :note_block_id
            """
        ),
        {"viewer_id": bootstrapped_user, "note_block_id": note_block_id},
    ).scalar_one()
    note_chunk_id = db_session.execute(
        text(
            """
            SELECT id
            FROM content_chunks
            WHERE owner_kind = 'note_block' AND owner_id = :note_block_id
            ORDER BY chunk_idx ASC, id ASC
            LIMIT 1
            """
        ),
        {"note_block_id": note_block_id},
    ).scalar_one()

    highlight_facts = highlights.recent_highlight_anchor_facts(
        db_session, viewer_id=bootstrapped_user, limit=5
    )
    assert highlight_facts[0].media_id == media_id
    note_facts = notes.recent_note_anchor_facts(db_session, viewer_id=bootstrapped_user, limit=5)
    assert {fact.ref.uri for fact in note_facts} >= {
        f"page:{page_id}",
        f"note_block:{note_block_id}",
    }

    owner_endpoints = """
        SELECT resource_scheme, resource_id
        FROM unnest(
            CAST(:resource_schemes AS text[]),
            CAST(:resource_ids AS uuid[])
        ) AS endpoint(resource_scheme, resource_id)
    """
    endpoint_pairs = [
        ("media", media_id),
        ("highlight", highlight_id),
        ("page", page_id),
        ("note_block", note_block_id),
        ("content_chunk", note_chunk_id),
    ]
    owner_rows = db_session.execute(
        text(
            f"""
            SELECT resource_scheme, resource_id, owner_scheme, owner_id
            FROM ({resolve.resource_owner_rows_sql(owner_endpoints)}) owners
            """
        ),
        {
            "resource_schemes": [scheme for scheme, _ in endpoint_pairs],
            "resource_ids": [resource_id for _, resource_id in endpoint_pairs],
        },
    ).mappings()
    owners = {
        (str(row["resource_scheme"]), UUID(str(row["resource_id"]))): (
            str(row["owner_scheme"]),
            UUID(str(row["owner_id"])),
        )
        for row in owner_rows
    }
    assert owners[("media", media_id)] == ("media", media_id)
    assert owners[("highlight", highlight_id)] == ("media", media_id)
    assert owners[("page", UUID(str(page_id)))] == ("page", UUID(str(page_id)))
    assert owners[("note_block", note_block_id)] == ("note_block", note_block_id)
    assert owners[("content_chunk", UUID(str(note_chunk_id)))] == (
        "note_block",
        note_block_id,
    )

    edges = db_session.execute(
        text(
            f"""
            SELECT edge_id, edge_kind, edge_origin,
                   source_scheme, source_id, target_scheme, target_id, created_at
            FROM ({connection_summaries.edge_fact_rows_sql()}) edge_facts
            """
        ),
        {
            "viewer_id": bootstrapped_user,
            "edge_origins": ["user", "highlight_note"],
        },
    ).mappings()
    assert any(
        row["source_scheme"] == "highlight"
        and row["source_id"] == highlight_id
        and row["target_scheme"] == "note_block"
        and row["target_id"] == note_block_id
        for row in edges
    )


def test_author_semantic_media_relations_are_visible_and_eligibility_first(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    anchor_id = create_searchable_media(db_session, bootstrapped_user, title="Resonant stars")
    peer_id = create_searchable_media(db_session, bootstrapped_user, title="Resonant starlight")
    contributor_id = uuid4()
    db_session.add(
        Contributor(
            id=contributor_id,
            handle=f"author-{contributor_id.hex[:12]}",
            display_name="Canonical Author",
        )
    )
    db_session.add(
        ContributorCredit(
            id=uuid4(),
            contributor_id=contributor_id,
            media_id=peer_id,
            credited_name="Byline Variant",
            normalized_credited_name=contributor_match_key("Byline Variant"),
            role="author",
            ordinal=0,
            source="manual",
        )
    )
    db_session.commit()

    author_row = (
        db_session.execute(
            text(
                f"""
                SELECT contributor_id, display_name, media_id, podcast_id
                FROM ({contributor_credits.visible_author_credit_rows_sql()}) authors
                WHERE media_id = :media_id
                """
            ),
            {"viewer_id": bootstrapped_user, "media_id": peer_id},
        )
        .mappings()
        .one()
    )
    assert author_row["contributor_id"] == contributor_id
    assert author_row["display_name"] == "Canonical Author"

    neighbor_rows = db_session.execute(
        text(
            semantic_chunks.media_neighbor_rows_sql(
                f"""
                SELECT media_id, 'owner-port-test'::text AS candidate_partition
                FROM ({visible_media_ids_cte_sql()}) visible_media
                """
            )
        ),
        {
            "viewer_id": bootstrapped_user,
            "anchor_media_id": anchor_id,
            "embedding_dimensions": semantic_chunks.transcript_embedding_dimensions(),
            "candidate_limit": 20,
        },
    ).mappings()
    neighbors = list(neighbor_rows)
    assert any(row["peer_media_id"] == peer_id for row in neighbors)
    assert all(float(row["distance"]) >= 0 for row in neighbors)
    assert {row["candidate_partition"] for row in neighbors} == {"owner-port-test"}

    query_count = 0

    def count_query(*_args: object) -> None:
        nonlocal query_count
        query_count += 1

    connection = db_session.connection()
    event.listen(connection, "before_cursor_execute", count_query)
    try:
        best_peer_rows = list(
            db_session.execute(
                text(semantic_chunks.media_best_peer_rows_sql(visible_media_ids_cte_sql())),
                {
                    "viewer_id": bootstrapped_user,
                    "embedding_dimensions": semantic_chunks.transcript_embedding_dimensions(),
                },
            ).mappings()
        )
    finally:
        event.remove(connection, "before_cursor_execute", count_query)
    assert query_count == 1, "full-membership semantic relation must execute as one DB query"
    best_by_anchor = {row["anchor_media_id"]: row for row in best_peer_rows}
    assert best_by_anchor[anchor_id]["peer_media_id"] == peer_id
    assert best_by_anchor[peer_id]["peer_media_id"] == anchor_id

    rediscovery_id = create_searchable_media(
        db_session,
        bootstrapped_user,
        title="A distant rediscovery partition",
    )
    partitioned_neighbors = list(
        db_session.execute(
            text(
                semantic_chunks.media_neighbor_rows_sql(
                    f"""
                    SELECT
                        media_id,
                        CASE
                            WHEN media_id = :peer_id THEN 'GraphThread'
                            ELSE 'Rediscovery'
                        END AS candidate_partition
                    FROM ({visible_media_ids_cte_sql()}) visible_media
                    WHERE media_id IN (:peer_id, :rediscovery_id)
                    """
                )
            ),
            {
                "viewer_id": bootstrapped_user,
                "anchor_media_id": anchor_id,
                "embedding_dimensions": semantic_chunks.transcript_embedding_dimensions(),
                "candidate_limit": 1,
                "peer_id": peer_id,
                "rediscovery_id": rediscovery_id,
            },
        ).mappings()
    )
    assert {
        (row["peer_media_id"], row["candidate_partition"]) for row in partitioned_neighbors
    } == {
        (peer_id, "GraphThread"),
        (rediscovery_id, "Rediscovery"),
    }

    candidate = (
        db_session.execute(
            text(
                f"""
                SELECT media_id, media_kind, created_at, published_date
                FROM ({media.media_candidate_rows_sql()}) candidates
                WHERE media_id = :media_id
                """
            ),
            {"media_id": peer_id},
        )
        .mappings()
        .one()
    )
    assert candidate["media_kind"] == MediaKind.web_article.value
    compact = media.hydrate_compact_media_targets(
        db_session, viewer_id=bootstrapped_user, media_ids=[peer_id]
    )[peer_id]
    assert compact.title == "Resonant starlight"
    assert compact.href == f"/media/{peer_id}"


def test_podcast_relations_expose_exact_publication_subscription_and_compact_target(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    podcast_id = uuid4()
    media_id = uuid4()
    published_at = datetime(2026, 7, 19, 9, 30, tzinfo=UTC)
    db_session.add(
        Podcast(
            id=podcast_id,
            provider="podcast_index",
            provider_podcast_id=f"podcast-{podcast_id}",
            title="A Precise Podcast",
            feed_url=f"https://example.com/{podcast_id}.xml",
            image_url="https://example.com/podcast.jpg",
        )
    )
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.podcast_episode.value,
            title="An Exact Episode",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    db_session.add(
        PodcastEpisode(
            media_id=media_id,
            podcast_id=podcast_id,
            provider_episode_id=f"episode-{media_id}",
            fallback_identity=f"fallback-{media_id}",
            published_at=published_at,
        )
    )
    db_session.add(
        PodcastSubscription(
            user_id=bootstrapped_user,
            podcast_id=podcast_id,
            status="active",
        )
    )
    db_session.flush()
    add_media_to_library(db_session, _default_library(db_session, bootstrapped_user), media_id)
    db_session.commit()

    publication = (
        db_session.execute(
            text(
                f"""
                SELECT media_id, podcast_id, published_at
                FROM ({episodes.episode_publication_rows_sql()}) publications
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one()
    )
    assert publication["podcast_id"] == podcast_id
    assert publication["published_at"] == published_at

    subscribed = db_session.execute(
        text(
            f"""
            SELECT podcast_id
            FROM ({subscriptions_query.active_subscription_rows_sql()}) subscriptions
            """
        ),
        {"viewer_id": bootstrapped_user},
    ).scalars()
    assert podcast_id in set(subscribed)
    compact_podcast = subscriptions_query.hydrate_compact_podcast_targets(
        db_session, viewer_id=bootstrapped_user, podcast_ids=[podcast_id]
    )[podcast_id]
    assert compact_podcast.title == "A Precise Podcast"
    assert compact_podcast.href == f"/podcasts/{podcast_id}"
    compact_episode = media.hydrate_compact_media_targets(
        db_session, viewer_id=bootstrapped_user, media_ids=[media_id]
    )[media_id]
    assert compact_episode.title == "An Exact Episode"
    assert compact_episode.subtitle.kind == "Present"


def test_library_slate_ignores_hidden_and_future_episode_publications(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    library_id = create_test_library(
        db_session,
        bootstrapped_user,
        "Visibility-scoped podcast publications",
    )
    default_library_id = _default_library(db_session, bootstrapped_user)
    as_of = db_session.execute(text("SELECT now()")).scalar_one()
    anchor_id = uuid4()
    podcast_ids = [uuid4() for _ in range(3)]
    visible_episode_ids = [uuid4() for _ in range(3)]
    hidden_episode_ids = [uuid4()]
    future_episode_id = uuid4()
    db_session.add(
        Media(
            id=anchor_id,
            kind=MediaKind.web_article.value,
            title="Podcast publication anchor",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=bootstrapped_user,
            created_at=as_of - timedelta(days=180),
        )
    )
    db_session.add_all(
        [
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"publication-{podcast_id}",
                title=f"Publication candidate {index}",
                feed_url=f"https://example.com/{podcast_id}.xml",
            )
            for index, podcast_id in enumerate(podcast_ids)
        ]
    )
    db_session.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=f"Publication episode {media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            for media_id in [
                *visible_episode_ids,
                *hidden_episode_ids,
                future_episode_id,
            ]
        ]
    )
    db_session.flush()
    db_session.add(
        LibraryEntry(
            library_id=library_id,
            media_id=anchor_id,
            position=0,
            created_at=as_of - timedelta(days=180),
        )
    )
    db_session.add_all(
        [
            PodcastSubscription(
                user_id=bootstrapped_user,
                podcast_id=podcast_id,
                status="active",
            )
            for podcast_id in podcast_ids
        ]
    )
    db_session.add_all(
        [
            PodcastEpisode(
                media_id=visible_episode_ids[0],
                podcast_id=podcast_ids[0],
                provider_episode_id=f"visible-{visible_episode_ids[0]}",
                fallback_identity=f"visible-{visible_episode_ids[0]}",
                published_at=as_of - timedelta(days=120),
            ),
            PodcastEpisode(
                media_id=hidden_episode_ids[0],
                podcast_id=podcast_ids[0],
                provider_episode_id=f"hidden-{hidden_episode_ids[0]}",
                fallback_identity=f"hidden-{hidden_episode_ids[0]}",
                published_at=as_of - timedelta(days=1),
            ),
            PodcastEpisode(
                media_id=visible_episode_ids[1],
                podcast_id=podcast_ids[1],
                provider_episode_id=f"visible-{visible_episode_ids[1]}",
                fallback_identity=f"visible-{visible_episode_ids[1]}",
                published_at=as_of - timedelta(days=20),
            ),
            PodcastEpisode(
                media_id=future_episode_id,
                podcast_id=podcast_ids[1],
                provider_episode_id=f"future-{future_episode_id}",
                fallback_identity=f"future-{future_episode_id}",
                published_at=as_of + timedelta(days=10),
            ),
            PodcastEpisode(
                media_id=visible_episode_ids[2],
                podcast_id=podcast_ids[2],
                provider_episode_id=f"visible-{visible_episode_ids[2]}",
                fallback_identity=f"visible-{visible_episode_ids[2]}",
                published_at=as_of - timedelta(days=40),
            ),
        ]
    )
    for media_id in [
        *visible_episode_ids,
        *hidden_episode_ids,
        future_episode_id,
    ]:
        add_media_to_library(db_session, default_library_id, media_id)
    db_session.add_all(
        [
            UserMediaDeletion(user_id=bootstrapped_user, media_id=media_id)
            for media_id in hidden_episode_ids
        ]
    )
    contributor_id = uuid4()
    db_session.add(
        Contributor(
            id=contributor_id,
            handle=f"publication-author-{contributor_id.hex[:12]}",
            display_name="Publication Author",
        )
    )
    db_session.add_all(
        [
            ContributorCredit(
                id=uuid4(),
                contributor_id=contributor_id,
                media_id=target_id if target_kind == "media" else None,
                podcast_id=target_id if target_kind == "podcast" else None,
                credited_name="Publication Author",
                normalized_credited_name=contributor_match_key("Publication Author"),
                role="author",
                ordinal=0,
                source="manual",
            )
            for target_kind, target_id in [
                ("media", anchor_id),
                *(("podcast", podcast_id) for podcast_id in podcast_ids),
            ]
        ]
    )
    db_session.commit()

    slate = resonance_service.build_library_slate(
        db_session,
        viewer_id=bootstrapped_user,
        library_id=library_id,
    )

    assert [item.target.ref for item in slate.items] == [
        f"podcast:{podcast_ids[1]}",
        f"podcast:{podcast_ids[2]}",
        f"podcast:{podcast_ids[0]}",
    ]
    assert all(item.reason.kind == "SharedAuthor" for item in slate.items)

    db_session.add_all(
        [
            PodcastListeningState(
                user_id=bootstrapped_user,
                media_id=visible_episode_ids[1],
                position_ms=60_000,
                duration_ms=300_000,
                last_engaged_at=as_of - timedelta(days=15),
                updated_at=as_of - timedelta(days=15),
            ),
            PodcastListeningState(
                user_id=bootstrapped_user,
                media_id=future_episode_id,
                position_ms=60_000,
                duration_ms=300_000,
                last_engaged_at=as_of + timedelta(days=5),
                updated_at=as_of + timedelta(days=5),
            ),
            PodcastListeningState(
                user_id=bootstrapped_user,
                media_id=visible_episode_ids[2],
                position_ms=60_000,
                duration_ms=300_000,
                last_engaged_at=as_of - timedelta(days=5),
                updated_at=as_of - timedelta(days=5),
            ),
        ]
    )
    db_session.commit()

    slate = resonance_service.build_library_slate(
        db_session,
        viewer_id=bootstrapped_user,
        library_id=library_id,
    )
    assert [item.target.ref for item in slate.items] == [
        f"podcast:{podcast_ids[2]}",
        f"podcast:{podcast_ids[1]}",
        f"podcast:{podcast_ids[0]}",
    ]


@pytest.mark.parametrize(
    ("relation_kind", "secondary_kind", "expected_reason"),
    [
        pytest.param("author", "engagement", "SharedAuthor", id="shared-author-engagement"),
        pytest.param("semantic", "arrival", "Similar", id="semantic-exact-arrival"),
    ],
)
def test_library_slate_family_preselection_preserves_contextually_superior_candidate(
    db_session: Session,
    bootstrapped_user: UUID,
    relation_kind: str,
    secondary_kind: str,
    expected_reason: str,
) -> None:
    library_id = create_test_library(
        db_session,
        bootstrapped_user,
        f"Contextual {relation_kind} preselection",
    )
    as_of = db_session.execute(text("SELECT now()")).scalar_one()
    ordinary_created_at = as_of - timedelta(days=30)
    superior_created_at = (
        as_of - timedelta(days=1) if secondary_kind == "arrival" else ordinary_created_at
    )
    anchor_id = UUID("80000000-0000-4000-8000-000000000000")
    ordinary_ids = [UUID(f"00000000-0000-4000-8000-{ordinal:012x}") for ordinal in range(1, 21)]
    superior_id = UUID("ffffffff-ffff-4fff-bfff-ffffffffffff")
    all_media_ids = [anchor_id, *ordinary_ids, superior_id]

    db_session.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=(
                    "Context anchor" if media_id == anchor_id else f"Context candidate {media_id}"
                ),
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=bootstrapped_user,
                created_at=(
                    superior_created_at if media_id == superior_id else ordinary_created_at
                ),
            )
            for media_id in all_media_ids
        ]
    )
    db_session.flush()
    db_session.add(
        LibraryEntry(
            library_id=library_id,
            media_id=anchor_id,
            position=0,
            created_at=ordinary_created_at,
        )
    )
    default_library_id = _default_library(db_session, bootstrapped_user)
    for media_id in [*ordinary_ids, superior_id]:
        add_media_to_library(db_session, default_library_id, media_id)

    if secondary_kind == "engagement":
        db_session.add_all(
            [
                ReaderEngagementState(
                    id=new_uuid7(),
                    user_id=bootstrapped_user,
                    media_id=superior_id,
                    last_engaged_at=as_of - timedelta(hours=1),
                    max_total_progression=0.4,
                ),
                ReaderEngagementState(
                    id=new_uuid7(),
                    user_id=bootstrapped_user,
                    media_id=ordinary_ids[0],
                    last_engaged_at=as_of + timedelta(days=1),
                    max_total_progression=0.4,
                ),
            ]
        )

    if relation_kind == "author":
        contributor_id = uuid4()
        db_session.add(
            Contributor(
                id=contributor_id,
                handle=f"context-author-{contributor_id.hex[:12]}",
                display_name="Context Author",
            )
        )
        db_session.add_all(
            [
                ContributorCredit(
                    id=uuid4(),
                    contributor_id=contributor_id,
                    media_id=media_id,
                    credited_name="Context Author",
                    normalized_credited_name=contributor_match_key("Context Author"),
                    role="author",
                    ordinal=0,
                    source="manual",
                )
                for media_id in all_media_ids
            ]
        )
    else:
        embedding_provider = "openai"
        embedding_model = "openai_text_embedding_3_small_256_v1"
        embedding_dimensions = 256
        embedding = [1.0, *([0.0] * (embedding_dimensions - 1))]
        for media_id in all_media_ids:
            chunk_id = uuid4()
            db_session.add(
                ContentChunk(
                    id=chunk_id,
                    owner_kind="media",
                    owner_id=media_id,
                    chunk_idx=0,
                    source_kind="web_article",
                    chunk_text="Contextually identical semantic evidence",
                    token_count=4,
                    heading_path=[],
                    summary_locator={},
                )
            )
            db_session.add(
                ContentEmbedding(
                    id=uuid4(),
                    chunk_id=chunk_id,
                    embedding_provider=embedding_provider,
                    embedding_model=embedding_model,
                    embedding_dimensions=embedding_dimensions,
                    embedding_vector=embedding,
                )
            )
            db_session.add(
                ContentIndexState(
                    id=uuid4(),
                    owner_kind="media",
                    owner_id=media_id,
                    status="ready",
                    active_embedding_provider=embedding_provider,
                    active_embedding_model=embedding_model,
                )
            )
    db_session.commit()

    slate = resonance_service.build_library_slate(
        db_session,
        viewer_id=bootstrapped_user,
        library_id=library_id,
    )

    assert len(slate.items) == 10
    assert slate.items[0].target.ref == f"media:{superior_id}"
    assert slate.items[0].reason.kind == expected_reason
