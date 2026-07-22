"""Integration tests for the consumption projection (spec §4/§5.2/§5.4):

- consumption-state derivation matrix (audio 95%/is_completed/position, doc
  reader-engagement any-row/95% threshold, explicit override precedence for
  both kinds);
- chapter worst-case bounds (first 100 by ordinal, 300-char title clamp,
  empty-title skip, both `endMs` Presence variants);
- the new `playerDescriptor` DTO field on MediaOut/the episode list (spec §6).

Media is seeded through ``direct_db``; commands and reads run through the real
HTTP surface (GET/POST /lectern, /consumption/commands, /media/{id}/listening-state)
plus the internal ``consumption_service`` boundary where there is no HTTP port.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    Media,
    MediaKind,
    Podcast,
    PodcastEpisode,
    PodcastEpisodeChapter,
    ProcessingStatus,
    ReaderEngagementState,
)
from nexus.ids import new_uuid7
from nexus.schemas.reader import (
    PdfReaderResumeState,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.services.consumption import _reader_engagement_store
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, f"/me bootstrap failed: {response.text}"
    return UUID(response.json()["data"]["default_library_id"])


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    for table in (
        "podcast_episodes",
        "podcast_episode_chapters",
        "consumption_queue_items",
        "consumption_overrides",
        "podcast_listening_states",
        "reader_engagement_states",
        "library_entries",
    ):
        direct_db.register_cleanup(table, "media_id", media_id)


def _create_web_article(direct_db: DirectSessionManager, *, title: str = "An Article") -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=title,
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    return media_id


def _create_podcast_episode(
    direct_db: DirectSessionManager,
    *,
    title: str = "An Episode",
    podcast_title: str = "A Show",
    image_url: str | None = "https://img.example.com/show.jpg",
    duration_seconds: int | None = 600,
) -> tuple[UUID, UUID]:
    """Returns ``(podcast_id, media_id)``."""
    media_id = uuid4()
    podcast_id = uuid4()
    provider_episode_id = f"episode-{media_id}"
    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"pp-{podcast_id}",
                title=podcast_title,
                feed_url=f"https://feeds.example.com/{podcast_id}.xml",
                image_url=image_url,
            )
        )
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=title,
                canonical_source_url=f"https://example.com/{provider_episode_id}",
                external_playback_url=f"https://cdn.example.com/{media_id}.mp3",
                provider="podcast_index",
                provider_id=provider_episode_id,
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.add(
            PodcastEpisode(
                media_id=media_id,
                podcast_id=podcast_id,
                provider_episode_id=provider_episode_id,
                guid=f"guid-{provider_episode_id}",
                fallback_identity=f"fallback-{provider_episode_id}",
                published_at="2026-03-22T00:00:00Z",
                duration_seconds=duration_seconds,
            )
        )
        session.commit()
    _register_media_cleanup(direct_db, media_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    return podcast_id, media_id


def _add_to_library(direct_db: DirectSessionManager, library_id: UUID, media_id: UUID) -> None:
    """Seed a physical library_entries row directly, bypassing the REST filing
    endpoint's membership-reachability gate: bare factory/direct-INSERT media
    isn't membership-reachable, so actor-authorized filing rejects it.
    Production ingest always auto-files freshly-created media into the
    creator's default library (ensure_media_in_default_library); this mirrors
    that reachability for fixture media created via a bare Media row rather
    than real ingest."""
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _place(auth_client, user_id, media_ids) -> list[dict]:
    response = auth_client.post(
        "/lectern/commands",
        headers=auth_headers(user_id),
        json={
            "kind": "PlaceItems",
            "clientMutationId": str(uuid4()),
            "mediaIds": [str(m) for m in media_ids],
            "placement": {"kind": "Last"},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]["lectern"]["items"]


def _get_lectern_item(auth_client, user_id, media_id) -> dict:
    response = auth_client.get("/lectern", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return next(i for i in response.json()["data"]["items"] if i["mediaId"] == str(media_id))


def _heartbeat(
    auth_client,
    user_id,
    media_id,
    *,
    position_ms,
    expected_write_revision=0,
    expected_reset_epoch=0,
    duration_ms=600_000,
):
    response = auth_client.put(
        f"/media/{media_id}/listening-state",
        headers=auth_headers(user_id),
        json={
            "positionMs": position_ms,
            "durationMs": {"kind": "Present", "value": duration_ms},
            "playbackSpeed": 1.0,
            "expectedWriteRevision": expected_write_revision,
            "expectedResetEpoch": expected_reset_epoch,
            "heartbeatGeneration": str(uuid4()),
            "heartbeatSequence": 1,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _consumption(auth_client, user_id, payload):
    response = auth_client.post(
        "/consumption/commands", headers=auth_headers(user_id), json=payload
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _seed_reader_engagement(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    media_id: UUID,
    max_total_progression: float | None = None,
    last_engaged_at: datetime | None = None,
) -> None:
    with direct_db.session() as session:
        session.add(
            ReaderEngagementState(
                id=new_uuid7(),
                user_id=user_id,
                media_id=media_id,
                last_engaged_at=last_engaged_at or datetime.now(UTC),
                max_total_progression=max_total_progression,
            )
        )
        session.commit()


def _is_completed(direct_db: DirectSessionManager, *, user_id: UUID, media_id: UUID) -> bool:
    with direct_db.session() as session:
        return bool(
            session.execute(
                text(
                    "SELECT is_completed FROM podcast_listening_states"
                    " WHERE user_id = :u AND media_id = :m"
                ),
                {"u": user_id, "m": media_id},
            ).scalar_one()
        )


def _override_row_exists(direct_db: DirectSessionManager, *, user_id: UUID, media_id: UUID) -> bool:
    with direct_db.session() as session:
        return (
            session.execute(
                text("SELECT 1 FROM consumption_overrides WHERE user_id = :u AND media_id = :m"),
                {"u": user_id, "m": media_id},
            ).fetchone()
            is not None
        )


class TestConsumptionStateDerivationMatrix:
    """Spec §5.4: "The 95%-threshold Finished signal is projection-only and
    never sets is_completed or prunes." Spec §5.2: "Explicit override remains
    the highest-priority state input.\" """

    def test_audio_ninety_five_percent_progress_derives_finished_without_completing(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])

        _heartbeat(auth_client, user_id, episode, position_ms=950_000, duration_ms=1_000_000)

        item = _get_lectern_item(auth_client, user_id, episode)
        assert item["consumption"]["state"] == "Finished", item
        assert item["consumption"]["progress"] == {"kind": "Present", "value": 0.95}
        # The 95% signal is projection-only: it never flips is_completed.
        assert _is_completed(direct_db, user_id=user_id, media_id=episode) is False

    def test_audio_is_completed_derives_finished_independent_of_override(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])

        # Set is_completed directly (bypassing the command layer, which always
        # pairs it with an override) to isolate the pure projection signal.
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO podcast_listening_states (user_id, media_id, is_completed)"
                    " VALUES (:u, :m, true)"
                ),
                {"u": user_id, "m": episode},
            )
            session.commit()

        assert _override_row_exists(direct_db, user_id=user_id, media_id=episode) is False
        item = _get_lectern_item(auth_client, user_id, episode)
        assert item["consumption"]["state"] == "Finished", item

    def test_audio_position_greater_than_zero_derives_in_progress(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])

        _heartbeat(auth_client, user_id, episode, position_ms=1_000, duration_ms=600_000)

        item = _get_lectern_item(auth_client, user_id, episode)
        assert item["consumption"]["state"] == "InProgress", item

    def test_audio_override_finished_beats_derived_in_progress(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])
        _heartbeat(auth_client, user_id, episode, position_ms=1_000, duration_ms=600_000)

        _consumption(
            auth_client,
            user_id,
            {
                "kind": "SetBatchState",
                "clientMutationId": str(uuid4()),
                "mediaIds": [str(episode)],
                "state": "Finished",
            },
        )

        item = _get_lectern_item(auth_client, user_id, episode)
        assert item["consumption"]["state"] == "Finished", item
        # SetBatchState is state-only: position is untouched, so this proves
        # override precedence rather than a coincidental 95%+ position.
        assert item["activation"]["positionMs"] == 1_000

    def test_audio_override_unread_beats_derived_finished(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])
        _heartbeat(auth_client, user_id, episode, position_ms=950_000, duration_ms=1_000_000)
        assert _get_lectern_item(auth_client, user_id, episode)["consumption"]["state"] == (
            "Finished"
        )

        _consumption(
            auth_client,
            user_id,
            {"kind": "SetUnread", "clientMutationId": str(uuid4()), "mediaId": str(episode)},
        )

        item = _get_lectern_item(auth_client, user_id, episode)
        assert item["consumption"]["state"] == "Unread", item

    def test_readable_no_engagement_derives_unread(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)
        _place(auth_client, user_id, [article])

        item = _get_lectern_item(auth_client, user_id, article)
        assert item["consumption"]["state"] == "Unread", item

    def test_readable_any_engagement_row_derives_in_progress(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)
        _place(auth_client, user_id, [article])
        # No dwell threshold left: any retained engagement row means in-progress
        # (spec §1 80/20 loss note), even with low/absent progression.
        _seed_reader_engagement(direct_db, user_id=user_id, media_id=article)

        item = _get_lectern_item(auth_client, user_id, article)
        assert item["consumption"]["state"] == "InProgress", item

    def test_readable_override_finished_beats_derived_unread(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)
        _place(auth_client, user_id, [article])
        # No engagement row at all: derived state would be Unread.

        _consumption(
            auth_client,
            user_id,
            {
                "kind": "EnsureMediaFinished",
                "clientMutationId": str(uuid4()),
                "mediaId": str(article),
            },
        )

        item = _get_lectern_item(auth_client, user_id, article)
        assert item["consumption"]["state"] == "Finished", item

    def test_readable_override_unread_beats_derived_finished(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)
        _place(auth_client, user_id, [article])
        # max_total_progression >= 0.95 derives Finished.
        _seed_reader_engagement(
            direct_db, user_id=user_id, media_id=article, max_total_progression=0.97
        )
        assert _get_lectern_item(auth_client, user_id, article)["consumption"]["state"] == (
            "Finished"
        )

        _consumption(
            auth_client,
            user_id,
            {"kind": "SetUnread", "clientMutationId": str(uuid4()), "mediaId": str(article)},
        )

        item = _get_lectern_item(auth_client, user_id, article)
        assert item["consumption"]["state"] == "Unread", item


class TestReaderEngagementStore:
    """Unit coverage for ``consumption/_reader_engagement_store.py`` directly
    (spec §4.4): GREATEST-based progression advance, PDF's untouched-on-update
    rule, and media-teardown delete."""

    def test_record_engagement_advances_progression_and_recency_for_non_pdf(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")

        def _web_locator(total_progression: float) -> WebReaderResumeState:
            return WebReaderResumeState(
                kind="web",
                target=ReaderFragmentTarget(fragment_id="frag-1"),
                locations=ReaderTextLocations(
                    text_offset=0,
                    progression=total_progression,
                    total_progression=total_progression,
                    position=1,
                ),
                text=ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None),
            )

        with direct_db.session() as session:
            _reader_engagement_store.record_engagement_in_txn(
                session, viewer_id=user_id, media_id=article, locator=_web_locator(0.4)
            )
            session.commit()
        states = None
        with direct_db.session() as session:
            states = _reader_engagement_store.load_states(
                session, viewer_id=user_id, media_ids=[article]
            )
        assert states[article].max_total_progression == pytest.approx(0.4)
        first_engaged_at = states[article].last_engaged_at

        # A lower progression save still advances last_engaged_at but never
        # regresses max_total_progression (GREATEST semantics).
        with direct_db.session() as session:
            _reader_engagement_store.record_engagement_in_txn(
                session, viewer_id=user_id, media_id=article, locator=_web_locator(0.1)
            )
            session.commit()
        with direct_db.session() as session:
            states = _reader_engagement_store.load_states(
                session, viewer_id=user_id, media_ids=[article]
            )
            recency = _reader_engagement_store.load_recency(
                session, viewer_id=user_id, media_ids=[article]
            )
        assert states[article].max_total_progression == pytest.approx(0.4)
        assert recency[article] >= first_engaged_at

    def test_record_engagement_leaves_pdf_progression_untouched(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        _bootstrap(auth_client, user_id)
        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.pdf.value,
                    title="A PDF",
                    canonical_source_url=f"https://example.com/{media_id}",
                    processing_status=ProcessingStatus.ready_for_reading,
                )
            )
            session.commit()
        direct_db.register_cleanup("reader_engagement_states", "media_id", media_id)

        pdf_locator = PdfReaderResumeState(
            kind="pdf", page=3, page_progression=0.9, zoom=1.0, position=None
        )
        with direct_db.session() as session:
            _reader_engagement_store.record_engagement_in_txn(
                session, viewer_id=user_id, media_id=media_id, locator=pdf_locator
            )
            session.commit()
        with direct_db.session() as session:
            states = _reader_engagement_store.load_states(
                session, viewer_id=user_id, media_ids=[media_id]
            )
        assert states[media_id].max_total_progression is None

    def test_delete_all_users_in_txn_clears_every_viewer_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a, user_b = create_test_user_id(), create_test_user_id()
        _bootstrap(auth_client, user_a)
        _bootstrap(auth_client, user_b)
        article = _create_web_article(direct_db, title="Shared Doc")
        for user_id in (user_a, user_b):
            _seed_reader_engagement(
                direct_db, user_id=user_id, media_id=article, max_total_progression=0.5
            )

        with direct_db.session() as session:
            _reader_engagement_store.delete_all_users_in_txn(session, media_id=article)
            session.commit()

        with direct_db.session() as session:
            states = _reader_engagement_store.load_states(
                session, viewer_id=user_a, media_ids=[article]
            )
            states.update(
                _reader_engagement_store.load_states(session, viewer_id=user_b, media_ids=[article])
            )
        assert states == {}


class TestChapterBounds:
    """Spec §4: "selects the first 100 by canonical ordinal, and clamps
    presentation titles to 300 characters; stored chapter data is not
    rewritten." Empty/whitespace titles are skipped (adversarial-review fix)."""

    def test_worst_case_first_100_clamp_and_empty_title_skip(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        _, episode = _create_podcast_episode(direct_db, title="Chaptered")
        _add_to_library(direct_db, library_id, episode)

        long_title = "A" * 350
        with direct_db.session() as session:
            for idx in range(105):
                if idx == 0:
                    title = long_title
                elif idx == 5:
                    title = "   "  # whitespace-only: must be skipped, not raise
                else:
                    title = f"Chapter {idx}"
                session.add(
                    PodcastEpisodeChapter(
                        media_id=episode,
                        chapter_idx=idx,
                        title=title,
                        t_start_ms=idx * 1_000,
                        # Alternate both `endMs` Presence variants.
                        t_end_ms=(idx * 1_000 + 500) if idx % 2 == 0 else None,
                        source="rss_podcasting20",
                    )
                )
            session.commit()

        placed = _place(auth_client, user_id, [episode])
        chapters = placed[0]["activation"]["chapters"]

        # 100 raw rows considered (idx 0..99); idx 5's empty title is excluded,
        # so 99 remain. idx 100..104 never enter the window at all.
        assert len(chapters) == 99, [c["startMs"] for c in chapters]
        start_ms_values = [c["startMs"] for c in chapters]
        assert 5_000 not in start_ms_values, "whitespace-only title chapter must be skipped"
        assert max(start_ms_values) == 99_000, "only the first 100 raw rows by ordinal are eligible"

        clamped = next(c for c in chapters if c["startMs"] == 0)
        assert clamped["title"] == long_title[:300]
        assert len(clamped["title"]) == 300

        present_end = next(c for c in chapters if c["startMs"] == 0)
        assert present_end["endMs"] == {"kind": "Present", "value": 500}
        absent_end = next(c for c in chapters if c["startMs"] == 1_000)
        assert absent_end["endMs"] == {"kind": "Absent"}


class TestPlayerDescriptor:
    """Spec §6: "Lectern, podcast, and media DTOs reuse the same server-derived
    title/subtitle + FooterAudio descriptor.\" """

    def test_media_and_episode_list_carry_present_descriptor_matching_lectern(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        podcast_id, episode = _create_podcast_episode(direct_db, title="Ep")
        _add_to_library(direct_db, library_id, episode)
        _place(auth_client, user_id, [episode])
        lectern_activation = _get_lectern_item(auth_client, user_id, episode)["activation"]
        assert lectern_activation["kind"] == "FooterAudio"

        media_resp = auth_client.get(f"/media/{episode}", headers=auth_headers(user_id))
        assert media_resp.status_code == 200, media_resp.text
        media_body = media_resp.json()["data"]
        assert "playerDescriptor" in media_body, "wire key must be exact camelCase"
        assert "player_descriptor" not in media_body
        descriptor = media_body["playerDescriptor"]
        assert descriptor["kind"] == "Present", descriptor
        assert descriptor["value"]["mediaId"] == str(episode)
        assert descriptor["value"]["activation"] == lectern_activation

        episodes_resp = auth_client.get(
            f"/podcasts/{podcast_id}/episodes", headers=auth_headers(user_id)
        )
        assert episodes_resp.status_code == 200, episodes_resp.text
        episode_row = episodes_resp.json()["data"][0]
        assert episode_row["playerDescriptor"] == descriptor

    def test_web_article_descriptor_is_absent(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        library_id = _bootstrap(auth_client, user_id)
        article = _create_web_article(direct_db, title="Doc")
        _add_to_library(direct_db, library_id, article)

        media_resp = auth_client.get(f"/media/{article}", headers=auth_headers(user_id))
        assert media_resp.status_code == 200, media_resp.text
        assert media_resp.json()["data"]["playerDescriptor"] == {"kind": "Absent"}
