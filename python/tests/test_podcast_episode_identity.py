from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.services.podcasts.episode_identity import (
    EpisodeIdentityConflict,
    aliases_from_episode,
    resolve_episode_aliases_in_current_transaction,
    validate_episode_alias_batch,
)
from nexus.services.podcasts.ingest import (
    SubscriptionIngestResult,
    sync_subscription_ingest,
)


def _episode(
    *, podcast_index_ref: str | None, guid: str | None, audio_url: str
) -> dict[str, object]:
    return {
        "podcast_index_episode_ref": podcast_index_ref,
        "guid": guid,
        "audio_url": audio_url,
    }


@pytest.mark.unit
def test_batch_rejects_duplicate_podcast_index_ref_without_shared_guid() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref="episode-1",
                    guid="guid-1",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref="episode-1",
                    guid="guid-2",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )


@pytest.mark.unit
def test_batch_rejects_duplicate_guid_without_podcast_index_proof() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref=None,
                    guid="same-guid",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref=None,
                    guid="same-guid",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )


@pytest.mark.unit
def test_batch_rejects_duplicate_podcast_index_even_when_guid_matches() -> None:
    with pytest.raises(EpisodeIdentityConflict):
        validate_episode_alias_batch(
            [
                _episode(
                    podcast_index_ref="episode-1",
                    guid="same-guid",
                    audio_url="https://example.com/one.mp3",
                ),
                _episode(
                    podcast_index_ref="episode-1",
                    guid="same-guid",
                    audio_url="https://example.com/two.mp3",
                ),
            ]
        )


# ---------------------------------------------------------------------------
# Stored-alias resolver proofs (§12). These drive the real ingest write path
# so the alias -> episode reconciliation is exercised against Postgres, not a
# stub. `sync_subscription_ingest` is the only caller of
# `resolve_episode_aliases_in_current_transaction` /
# `attach_episode_aliases_in_current_transaction`; a candidate ingested a
# second time replays exactly the stored-alias resolution AC12 governs.
# ---------------------------------------------------------------------------


def _create_podcast(db: Session, viewer_id: UUID) -> tuple[UUID, str]:
    """Insert one Podcast Index podcast + the viewer's subscription."""
    podcast_id = uuid4()
    feed_url = f"https://feeds.example.com/{podcast_id}.xml"
    db.execute(
        text(
            """
            INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
            VALUES (:id, 'podcast_index', :provider_podcast_id, 'Identity Fixture', :feed_url)
            """
        ),
        {
            "id": podcast_id,
            "provider_podcast_id": f"podcast-{podcast_id}",
            "feed_url": feed_url,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_subscriptions (id, user_id, podcast_id)
            VALUES (:id, :viewer_id, :podcast_id)
            """
        ),
        {"id": new_uuid7(), "viewer_id": viewer_id, "podcast_id": podcast_id},
    )
    return podcast_id, feed_url


def _ingest_episode(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    feed_url: str,
    podcast_index_ref: str | None,
    guid: str | None,
    audio_url: str,
    title: str = "Episode",
) -> SubscriptionIngestResult:
    """Ingest exactly one candidate episode through the fenced batch path."""
    return sync_subscription_ingest(
        db=db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        selected_episodes=[
            {
                "podcast_index_episode_ref": podcast_index_ref,
                "guid": guid,
                "title": title,
                "audio_url": audio_url,
                "published_at": "2026-07-29T12:00:00Z",
                "duration_seconds": 60,
                "authors": [],
            }
        ],
        now=datetime.now(UTC),
    )


def _episode_count(db: Session, podcast_id: UUID) -> int:
    return int(
        db.scalar(
            text("SELECT count(*) FROM podcast_episodes WHERE podcast_id = :podcast_id"),
            {"podcast_id": podcast_id},
        )
    )


def _media_episode_count(db: Session, podcast_id: UUID) -> int:
    return int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM podcast_episodes episode
                JOIN media ON media.id = episode.media_id
                WHERE episode.podcast_id = :podcast_id
                  AND media.kind = 'podcast_episode'
                """
            ),
            {"podcast_id": podcast_id},
        )
    )


def _identity_rows(db: Session, podcast_id: UUID) -> list[tuple[str, str, UUID]]:
    return [
        (str(row["scheme"]), str(row["value"]), UUID(str(row["episode_media_id"])))
        for row in db.execute(
            text(
                """
                SELECT scheme, value, episode_media_id
                FROM podcast_episode_identities
                WHERE podcast_id = :podcast_id
                """
            ),
            {"podcast_id": podcast_id},
        ).mappings()
    ]


@pytest.mark.integration
def test_stored_rss_only_then_podcast_index_converges_to_one_episode(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """AC12: an RSS-only episode acquired first is reused when Podcast Index
    later carries the same GUID; the three aliases file to one episode."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)
    audio_url = "https://cdn.example.com/converge.mp3"

    rss_only = _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref=None,
        guid="shared-guid",
        audio_url=audio_url,
    )
    assert rss_only.ingested_episode_count == 1
    assert rss_only.reused_episode_count == 0

    with_podcast_index = _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-ref",
        guid="shared-guid",
        audio_url=audio_url,
    )
    assert with_podcast_index.ingested_episode_count == 0
    assert with_podcast_index.reused_episode_count == 1

    assert _episode_count(db_session, podcast_id) == 1
    assert _media_episode_count(db_session, podcast_id) == 1

    rows = _identity_rows(db_session, podcast_id)
    assert len({media_id for _, _, media_id in rows}) == 1
    by_scheme = {scheme: value for scheme, value, _ in rows}
    assert set(by_scheme) == {"PodcastIndex", "RssGuid", "RssEnclosure"}
    assert by_scheme["PodcastIndex"] == "pi-ref"
    assert by_scheme["RssGuid"] == "shared-guid"


@pytest.mark.integration
def test_stored_podcast_index_then_rss_only_converges_to_one_episode(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """Mirror of the above: Podcast Index first, then an RSS-only feed row with
    the same GUID reuses the existing episode rather than forking a new one."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)
    audio_url = "https://cdn.example.com/converge.mp3"

    with_podcast_index = _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-ref",
        guid="shared-guid",
        audio_url=audio_url,
    )
    assert with_podcast_index.ingested_episode_count == 1
    assert with_podcast_index.reused_episode_count == 0

    rss_only = _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref=None,
        guid="shared-guid",
        audio_url=audio_url,
    )
    assert rss_only.ingested_episode_count == 0
    assert rss_only.reused_episode_count == 1

    assert _episode_count(db_session, podcast_id) == 1
    assert _media_episode_count(db_session, podcast_id) == 1

    rows = _identity_rows(db_session, podcast_id)
    assert len({media_id for _, _, media_id in rows}) == 1
    by_scheme = {scheme: value for scheme, value, _ in rows}
    assert set(by_scheme) == {"PodcastIndex", "RssGuid", "RssEnclosure"}
    assert by_scheme["PodcastIndex"] == "pi-ref"
    assert by_scheme["RssGuid"] == "shared-guid"


@pytest.mark.integration
def test_stored_candidate_spanning_two_episodes_conflicts_before_mutation(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """AC12 rule 3: a candidate whose aliases resolve to two distinct stored
    episodes raises before any episode is chosen or filed."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-a",
        guid="guid-a",
        audio_url="https://cdn.example.com/a.mp3",
        title="Episode A",
    )
    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-b",
        guid="guid-b",
        audio_url="https://cdn.example.com/b.mp3",
        title="Episode B",
    )
    assert _episode_count(db_session, podcast_id) == 2

    # PodcastIndex points at episode A while the GUID points at episode B.
    candidate = aliases_from_episode(
        {"podcast_index_episode_ref": "pi-a", "guid": "guid-b", "audio_url": ""}
    )
    with pytest.raises(EpisodeIdentityConflict):
        resolve_episode_aliases_in_current_transaction(
            db_session,
            podcast_id=podcast_id,
            aliases=candidate,
        )

    # The resolver rejected the ambiguity without materializing a third episode
    # or rebinding either existing one.
    assert _episode_count(db_session, podcast_id) == 2


@pytest.mark.integration
def test_stored_duplicate_guid_with_new_enclosure_conflicts_without_podcast_index(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """AC12 rule 4: a repeated GUID that carries a new enclosure and no Podcast
    Index equivalence is ambiguous and rejected."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref=None,
        guid="guid-dup",
        audio_url="https://cdn.example.com/enclosure-1.mp3",
    )
    assert _episode_count(db_session, podcast_id) == 1

    candidate = aliases_from_episode(
        {
            "podcast_index_episode_ref": None,
            "guid": "guid-dup",
            "audio_url": "https://cdn.example.com/enclosure-2.mp3",
        }
    )
    with pytest.raises(EpisodeIdentityConflict):
        resolve_episode_aliases_in_current_transaction(
            db_session,
            podcast_id=podcast_id,
            aliases=candidate,
        )

    assert _episode_count(db_session, podcast_id) == 1


@pytest.mark.integration
def test_stored_duplicate_guid_with_new_enclosure_attaches_when_podcast_index_proves(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """AC12 rule 4: the same repeated-GUID/new-enclosure candidate resolves and
    attaches its new enclosure once a bound Podcast Index alias proves identity."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-proof",
        guid="guid-dup",
        audio_url="https://cdn.example.com/enclosure-1.mp3",
    )
    assert _episode_count(db_session, podcast_id) == 1

    reused = _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-proof",
        guid="guid-dup",
        audio_url="https://cdn.example.com/enclosure-2.mp3",
    )
    assert reused.ingested_episode_count == 0
    assert reused.reused_episode_count == 1

    assert _episode_count(db_session, podcast_id) == 1
    rows = _identity_rows(db_session, podcast_id)
    assert len({media_id for _, _, media_id in rows}) == 1
    enclosures = {value for scheme, value, _ in rows if scheme == "RssEnclosure"}
    assert len(enclosures) == 2


@pytest.mark.integration
def test_stored_second_podcast_index_alias_on_one_episode_conflicts(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """A GUID-matched candidate carrying a different Podcast Index ref would put
    two PodcastIndex aliases on one episode: `_require_one_strong_alias_per_scheme`
    forbids it."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-first",
        guid="guid-shared",
        audio_url="https://cdn.example.com/one.mp3",
    )

    candidate = aliases_from_episode(
        {"podcast_index_episode_ref": "pi-second", "guid": "guid-shared", "audio_url": ""}
    )
    with pytest.raises(EpisodeIdentityConflict):
        resolve_episode_aliases_in_current_transaction(
            db_session,
            podcast_id=podcast_id,
            aliases=candidate,
        )


@pytest.mark.integration
def test_stored_second_rss_guid_alias_on_one_episode_conflicts(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """The mirror guard: a Podcast-Index-matched candidate carrying a different
    GUID would put two RssGuid aliases on one episode and is rejected."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    _ingest_episode(
        db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        podcast_index_ref="pi-shared",
        guid="guid-first",
        audio_url="https://cdn.example.com/one.mp3",
    )

    candidate = aliases_from_episode(
        {"podcast_index_episode_ref": "pi-shared", "guid": "guid-second", "audio_url": ""}
    )
    with pytest.raises(EpisodeIdentityConflict):
        resolve_episode_aliases_in_current_transaction(
            db_session,
            podcast_id=podcast_id,
            aliases=candidate,
        )


@pytest.mark.integration
def test_stored_candidate_without_strong_alias_is_source_limited_not_materialized(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    """AC12 final clause: a candidate with no Podcast Index ref, no GUID, and no
    valid enclosure has no stable identity: it is omitted (never materialized as
    an episode/Media row) and the traversal is marked SourceLimited."""
    viewer_id = bootstrapped_user
    podcast_id, feed_url = _create_podcast(db_session, viewer_id)

    result = sync_subscription_ingest(
        db=db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url=feed_url,
        selected_episodes=[
            {
                "podcast_index_episode_ref": None,
                "guid": None,
                "title": "No stable identity",
                "audio_url": "",
                "published_at": "2026-07-29T12:00:00Z",
                "duration_seconds": 60,
                "authors": [],
            }
        ],
        now=datetime.now(UTC),
    )

    assert result.source_limited is True
    assert result.ingested_episode_count == 0
    assert result.reused_episode_count == 0
    assert _episode_count(db_session, podcast_id) == 0
    assert _identity_rows(db_session, podcast_id) == []
