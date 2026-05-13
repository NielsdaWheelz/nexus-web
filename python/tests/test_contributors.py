import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.contributors import (
    ContributorAliasCreateRequest,
    ContributorExternalIdCreateRequest,
    ContributorMergeRequest,
    ContributorSplitRequest,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import (
    contributor_credit_previews_for_names,
    replace_gutenberg_contributor_credits,
    replace_media_contributor_credits,
    replace_podcast_contributor_credits,
)
from nexus.services.contributors import (
    add_contributor_alias,
    add_contributor_external_id,
    delete_contributor_alias,
    delete_contributor_external_id,
    get_contributor_by_handle,
    hydrate_contributor_object_ref,
    list_contributor_works,
    merge_contributors,
    search_contributors,
    split_contributor,
    tombstone_contributor,
)
from nexus.services.object_refs import search_object_refs
from tests.factories import (
    add_media_to_library,
    create_test_conversation,
    create_test_media,
    create_test_media_in_library,
    create_test_message,
)
from tests.helpers import auth_headers, create_test_user_id

CURATOR_ROLES = frozenset({"contributor_curator"})


@pytest.mark.integration
def test_name_only_credits_do_not_auto_merge_by_alias(db_session):
    media_a = create_test_media(db_session, title=f"Contributor A {uuid4()}")
    media_b = create_test_media(db_session, title=f"Contributor B {uuid4()}")

    for media_id in (media_a, media_b):
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[
                {
                    "name": "Same Display Name",
                    "role": "author",
                    "source": "test_provider",
                }
            ],
        )

    rows = db_session.execute(
        text(
            """
            SELECT media_id, contributor_id
            FROM contributor_credits
            WHERE media_id IN (:media_a, :media_b)
            ORDER BY media_id
            """
        ),
        {"media_a": media_a, "media_b": media_b},
    ).fetchall()

    assert len(rows) == 2
    assert rows[0][1] != rows[1][1]


@pytest.mark.integration
def test_external_id_credits_reuse_the_same_contributor(db_session):
    media_a = create_test_media(db_session, title=f"External Contributor A {uuid4()}")
    media_b = create_test_media(db_session, title=f"External Contributor B {uuid4()}")
    external_key = f"orcid-{uuid4()}"

    for media_id in (media_a, media_b):
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[
                {
                    "name": "Authority Matched Name",
                    "role": "author",
                    "source": "test_provider",
                    "external_id": {
                        "authority": "orcid",
                        "external_key": external_key,
                    },
                }
            ],
        )

    rows = db_session.execute(
        text(
            """
            SELECT contributor_id, resolution_status
            FROM contributor_credits
            WHERE media_id IN (:media_a, :media_b)
            ORDER BY media_id
            """
        ),
        {"media_a": media_a, "media_b": media_b},
    ).fetchall()
    external_id_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributor_external_ids
            WHERE authority = 'orcid'
              AND external_key = :external_key
            """
        ),
        {"external_key": external_key},
    ).scalar_one()

    assert len(rows) == 2
    assert rows[0][0] == rows[1][0]
    assert {row[1] for row in rows} == {"external_id"}
    assert external_id_count == 1


@pytest.mark.integration
def test_concurrent_external_id_credits_reselect_same_contributor(direct_db):
    credited_name = f"Concurrent External Contributor {uuid4()}"
    external_key = f"orcid-{uuid4()}"
    source = f"contributor-race-{uuid4()}"
    media_ids: list[UUID] = []

    with direct_db.session() as session:
        media_ids = [
            create_test_media(session, title=f"Contributor race {index} {uuid4()}")
            for index in range(2)
        ]
        session.commit()

    direct_db.register_cleanup("contributors", "display_name", credited_name)
    direct_db.register_cleanup("contributor_aliases", "source", source)
    direct_db.register_cleanup("contributor_external_ids", "source", source)
    for media_id in media_ids:
        direct_db.register_cleanup("media", "id", media_id)

    barrier = threading.Barrier(len(media_ids))
    errors: list[BaseException] = []
    lock = threading.Lock()

    def replace_once(media_id: UUID) -> None:
        try:
            barrier.wait(timeout=5)
            with direct_db.session() as session:
                replace_media_contributor_credits(
                    session,
                    media_id=media_id,
                    credits=[
                        {
                            "name": credited_name,
                            "role": "author",
                            "source": source,
                            "external_id": {
                                "authority": "orcid",
                                "external_key": external_key,
                            },
                        }
                    ],
                )
                session.commit()
        except BaseException as exc:  # pragma: no cover - surfaced below.
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=replace_once, args=(media_id,)) for media_id in media_ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    for thread in threads:
        if thread.is_alive():
            errors.append(AssertionError(f"worker thread did not finish: {thread.name}"))

    assert errors == []

    with direct_db.session() as session:
        rows = session.execute(
            text(
                """
                SELECT contributor_id
                FROM contributor_credits
                WHERE media_id = ANY(:media_ids)
                ORDER BY media_id
                """
            ),
            {"media_ids": media_ids},
        ).fetchall()
        external_id_count = session.execute(
            text(
                """
                SELECT count(*)
                FROM contributor_external_ids
                WHERE authority = 'orcid'
                  AND external_key = :external_key
                """
            ),
            {"external_key": external_key},
        ).scalar_one()

    assert len(rows) == 2
    assert rows[0][0] == rows[1][0]
    assert external_id_count == 1


@pytest.mark.integration
def test_manual_confirmed_alias_can_resolve_new_credit(db_session):
    media_a = create_test_media(db_session, title=f"Manual Alias A {uuid4()}")
    media_b = create_test_media(db_session, title=f"Manual Alias B {uuid4()}")

    replace_media_contributor_credits(
        db_session,
        media_id=media_a,
        credits=[
            {
                "name": "Curated Alias",
                "role": "author",
                "source": "manual",
            }
        ],
    )
    manual_contributor_id = db_session.execute(
        text(
            """
            SELECT contributor_id
            FROM contributor_credits
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_a},
    ).scalar_one()

    replace_media_contributor_credits(
        db_session,
        media_id=media_b,
        credits=[
            {
                "name": "Curated Alias",
                "role": "author",
                "source": "provider_byline",
            }
        ],
    )
    provider_row = db_session.execute(
        text(
            """
            SELECT contributor_id, resolution_status
            FROM contributor_credits
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_b},
    ).fetchone()

    assert provider_row is not None
    assert provider_row[0] == manual_contributor_id
    assert provider_row[1] == "confirmed_alias"


@pytest.mark.integration
def test_duplicate_confirmed_aliases_do_not_auto_resolve(db_session):
    media_a = create_test_media(db_session, title=f"Ambiguous Alias A {uuid4()}")
    media_b = create_test_media(db_session, title=f"Ambiguous Alias B {uuid4()}")
    ambiguous_alias = "Ambiguous Pen Name"
    normalized_alias = "ambiguous pen name"

    replace_media_contributor_credits(
        db_session,
        media_id=media_a,
        credits=[
            {
                "name": ambiguous_alias,
                "role": "author",
                "source": "manual",
            }
        ],
    )
    first_contributor_id = db_session.execute(
        text(
            """
            SELECT contributor_id
            FROM contributor_credits
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_a},
    ).scalar_one()

    second_contributor_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO contributors (
                id,
                handle,
                display_name,
                sort_name,
                kind,
                status
            )
            VALUES (
                :id,
                :handle,
                :display_name,
                :display_name,
                'unknown',
                'unverified'
            )
            """
        ),
        {
            "id": second_contributor_id,
            "handle": f"ambiguous-pen-name-{uuid4().hex[:8]}",
            "display_name": ambiguous_alias,
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO contributor_aliases (
                contributor_id,
                alias,
                normalized_alias,
                alias_kind,
                source,
                is_primary
            )
            VALUES (
                :contributor_id,
                :alias,
                :normalized_alias,
                'display',
                'manual',
                true
            )
            """
        ),
        {
            "contributor_id": second_contributor_id,
            "alias": ambiguous_alias,
            "normalized_alias": normalized_alias,
        },
    )

    replace_media_contributor_credits(
        db_session,
        media_id=media_b,
        credits=[
            {
                "name": ambiguous_alias,
                "role": "author",
                "source": "provider_byline",
            }
        ],
    )
    provider_row = db_session.execute(
        text(
            """
            SELECT contributor_id, resolution_status
            FROM contributor_credits
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_b},
    ).fetchone()

    assert provider_row is not None
    assert provider_row[0] not in {first_contributor_id, second_contributor_id}
    assert provider_row[1] == "unverified"


@pytest.mark.integration
def test_name_only_previews_do_not_attach_display_name_matches(db_session):
    media_id = create_test_media(db_session, title=f"Preview Display Name {uuid4()}")
    credited_name = f"Unconfirmed Preview Name {uuid4()}"
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": credited_name, "role": "author", "source": "rss"}],
    )

    previews = contributor_credit_previews_for_names(
        db_session,
        [credited_name],
        role="author",
        source="podcast_index",
    )

    assert previews == []


@pytest.mark.integration
def test_name_only_previews_can_attach_confirmed_alias(db_session):
    media_id = create_test_media(db_session, title=f"Preview Confirmed Alias {uuid4()}")
    credited_name = f"Confirmed Preview Name {uuid4()}"
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": credited_name, "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    previews = contributor_credit_previews_for_names(
        db_session,
        [credited_name],
        role="author",
        source="podcast_index",
    )

    assert len(previews) == 1
    assert previews[0].contributor_handle == handle
    assert previews[0].resolution_status == "confirmed_alias"


@pytest.mark.integration
def test_replace_credits_deletes_only_replacing_source(db_session):
    media_id = create_test_media(db_session, title=f"Source Scoped Credits {uuid4()}")

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {
                "name": "Provider Author",
                "role": "author",
                "source": "rss",
            }
        ],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {
                "name": "Curated Author",
                "role": "author",
                "source": "manual",
            }
        ],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {
                "name": "Provider Replacement",
                "role": "author",
                "source": "rss",
            }
        ],
    )

    rows = db_session.execute(
        text(
            """
            SELECT source, credited_name
            FROM contributor_credits
            WHERE media_id = :media_id
            ORDER BY source, credited_name
            """
        ),
        {"media_id": media_id},
    ).fetchall()

    assert ("manual", "Curated Author") in rows
    assert ("rss", "Provider Replacement") in rows
    assert ("rss", "Provider Author") not in rows


@pytest.mark.integration
def test_replace_credits_can_delete_empty_source_reingest(db_session):
    media_id = create_test_media(db_session, title=f"Empty Source Reingest {uuid4()}")

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Provider Author", "role": "author", "source": "rss"}],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Curated Author", "role": "author", "source": "manual"}],
    )

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[],
        source="rss",
    )

    rows = db_session.execute(
        text(
            """
            SELECT source, credited_name
            FROM contributor_credits
            WHERE media_id = :media_id
            ORDER BY source, credited_name
            """
        ),
        {"media_id": media_id},
    ).fetchall()

    assert rows == [("manual", "Curated Author")]


@pytest.mark.integration
def test_name_only_media_reingest_reuses_same_source_contributor(db_session):
    media_id = create_test_media(db_session, title=f"Media Reingest {uuid4()}")

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Stable Media Author", "role": "author", "source": "rss"}],
    )
    first_row = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Stable Media Author", "role": "author", "source": "rss"}],
    )

    rows = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    contributor_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributors
            WHERE display_name = 'Stable Media Author'
            """
        )
    ).scalar_one()

    assert len(rows) == 1
    assert rows[0] == first_row
    assert contributor_count == 1


@pytest.mark.integration
def test_name_only_podcast_reingest_reuses_same_source_contributor(db_session):
    podcast_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO podcasts (
                id,
                provider,
                provider_podcast_id,
                title,
                feed_url
            )
            VALUES (
                :id,
                'podcast_index',
                :provider_podcast_id,
                'Stable Podcast',
                :feed_url
            )
            """
        ),
        {
            "id": podcast_id,
            "provider_podcast_id": f"stable-podcast-{uuid4()}",
            "feed_url": f"https://feeds.example.com/stable-podcast-{uuid4()}.xml",
        },
    )

    replace_podcast_contributor_credits(
        db_session,
        podcast_id=podcast_id,
        credits=[
            {
                "credited_name": "Stable Podcast Author",
                "role": "author",
                "source": "podcast_index",
            }
        ],
    )
    first_row = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).one()

    replace_podcast_contributor_credits(
        db_session,
        podcast_id=podcast_id,
        credits=[
            {
                "credited_name": "Stable Podcast Author",
                "role": "author",
                "source": "podcast_index",
            }
        ],
    )

    rows = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchall()
    contributor_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributors
            WHERE display_name = 'Stable Podcast Author'
            """
        )
    ).scalar_one()

    assert len(rows) == 1
    assert rows[0] == first_row
    assert contributor_count == 1


@pytest.mark.integration
def test_name_only_gutenberg_reingest_reuses_same_source_contributor(db_session):
    ebook_id = 900000 + int(uuid4().int % 99999)
    db_session.execute(
        text(
            """
            INSERT INTO project_gutenberg_catalog (ebook_id, title)
            VALUES (:ebook_id, :title)
            """
        ),
        {"ebook_id": ebook_id, "title": f"Stable Gutenberg {uuid4()}"},
    )

    replace_gutenberg_contributor_credits(
        db_session,
        ebook_id=ebook_id,
        credits=[{"name": "Stable Gutenberg Author", "role": "author", "source": "gutenberg"}],
    )
    first_row = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.project_gutenberg_catalog_ebook_id = :ebook_id
            """
        ),
        {"ebook_id": ebook_id},
    ).one()

    replace_gutenberg_contributor_credits(
        db_session,
        ebook_id=ebook_id,
        credits=[{"name": "Stable Gutenberg Author", "role": "author", "source": "gutenberg"}],
    )

    rows = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.project_gutenberg_catalog_ebook_id = :ebook_id
            """
        ),
        {"ebook_id": ebook_id},
    ).fetchall()
    contributor_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributors
            WHERE display_name = 'Stable Gutenberg Author'
            """
        )
    ).scalar_one()

    assert len(rows) == 1
    assert rows[0] == first_row
    assert contributor_count == 1


@pytest.mark.integration
def test_public_contributor_reads_require_visible_credit(db_session):
    viewer_id = uuid4()
    default_library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media(db_session, title=f"Private Contributor {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Private Detail Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    with pytest.raises(NotFoundError):
        get_contributor_by_handle(db_session, handle, viewer_id)
    with pytest.raises(NotFoundError):
        hydrate_contributor_object_ref(db_session, viewer_id, contributor_id)

    add_media_to_library(db_session, default_library_id, media_id)
    db_session.commit()

    assert get_contributor_by_handle(db_session, handle, viewer_id).handle == handle
    assert hydrate_contributor_object_ref(db_session, viewer_id, contributor_id).object_id == (
        contributor_id
    )


@pytest.mark.integration
def test_contributor_pane_opens_from_user_object_link_with_no_visible_works(db_session):
    viewer_id = uuid4()
    default_library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media(db_session, title=f"Contributor Link Empty Works {uuid4()}")
    add_media_to_library(db_session, default_library_id, media_id)
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Linked Empty Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )

    with pytest.raises(NotFoundError):
        get_contributor_by_handle(db_session, handle, viewer_id)

    db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :contributor_id, 'media', :media_id,
                '{}'::jsonb
            )
            """
        ),
        {"user_id": viewer_id, "contributor_id": contributor_id, "media_id": media_id},
    )

    assert get_contributor_by_handle(db_session, handle, viewer_id).handle == handle
    assert list_contributor_works(db_session, viewer_id, handle) == []


@pytest.mark.integration
def test_contributor_pane_opens_from_message_context_with_no_visible_works(db_session):
    viewer_id = uuid4()
    ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media(db_session, title=f"Contributor Context Empty Works {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Context Empty Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )
    conversation_id = create_test_conversation(db_session, viewer_id)
    message_id = create_test_message(db_session, conversation_id, seq=1)

    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id, user_id, object_type, object_id, ordinal, context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'contributor',
                :contributor_id,
                0,
                CAST(:snapshot AS jsonb)
            )
            """
        ),
        {
            "message_id": message_id,
            "user_id": viewer_id,
            "contributor_id": contributor_id,
            "snapshot": '{"objectType":"contributor","label":"Context Empty Author"}',
        },
    )

    assert get_contributor_by_handle(db_session, handle, viewer_id).handle == handle
    assert list_contributor_works(db_session, viewer_id, handle) == []


@pytest.mark.integration
def test_project_gutenberg_catalog_credits_are_public_contributor_reads(db_session):
    viewer_id = uuid4()
    ensure_user_and_default_library(db_session, viewer_id)
    ebook_id = 900000 + int(uuid4().int % 99999)
    db_session.execute(
        text(
            """
            INSERT INTO project_gutenberg_catalog (ebook_id, title)
            VALUES (:ebook_id, :title)
            """
        ),
        {"ebook_id": ebook_id, "title": f"Public Gutenberg {uuid4()}"},
    )
    replace_gutenberg_contributor_credits(
        db_session,
        ebook_id=ebook_id,
        credits=[{"name": "Public Gutenberg Author", "role": "author", "source": "gutenberg"}],
    )
    contributor_id = db_session.execute(
        text(
            """
            SELECT contributor_id
            FROM contributor_credits
            WHERE project_gutenberg_catalog_ebook_id = :ebook_id
            """
        ),
        {"ebook_id": ebook_id},
    ).scalar_one()
    handle = db_session.execute(
        text("SELECT handle FROM contributors WHERE id = :contributor_id"),
        {"contributor_id": contributor_id},
    ).scalar_one()

    assert get_contributor_by_handle(db_session, handle, viewer_id).handle == handle
    assert hydrate_contributor_object_ref(db_session, viewer_id, contributor_id).object_id == (
        contributor_id
    )


@pytest.mark.integration
def test_contributor_search_matches_visible_credited_name(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Credited Name Search {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Original Search Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text(
            """
            UPDATE contributor_credits
            SET credited_name = 'Reviewed Credit Alias',
                normalized_credited_name = 'reviewed credit alias'
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )

    results = search_contributors(
        db_session,
        viewer_id=viewer_id,
        q="Reviewed Credit Alias",
    )

    assert [(result.handle, result.matched_name) for result in results] == [
        (handle, "Reviewed Credit Alias")
    ]
    assert contributor_id is not None


@pytest.mark.integration
def test_object_ref_search_matches_visible_credited_name_and_external_id(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Object ref contributor source {uuid4()}",
    )
    external_key = f"viaf-{uuid4()}"
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {
                "name": "Object Ref Display Name",
                "role": "author",
                "source": "manual",
                "external_id": {"authority": "viaf", "external_key": external_key},
            }
        ],
    )
    contributor_id, _handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text(
            """
            UPDATE contributor_credits
            SET credited_name = 'Object Ref Credited Alias',
                normalized_credited_name = 'object ref credited alias'
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )

    credited_name_refs = search_object_refs(
        db_session,
        viewer_id,
        "Object Ref Credited Alias",
        limit=10,
    )
    external_id_refs = search_object_refs(db_session, viewer_id, external_key, limit=10)

    assert ("contributor", contributor_id) in {
        (ref.object_type, ref.object_id) for ref in credited_name_refs
    }
    assert ("contributor", contributor_id) in {
        (ref.object_type, ref.object_id) for ref in external_id_refs
    }


@pytest.mark.integration
def test_contributor_curation_adds_and_removes_aliases_and_external_ids(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Curated Contributor {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Curated Service Author", "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    with_alias = add_contributor_alias(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=handle,
        request=ContributorAliasCreateRequest(alias="Curated Pen Name", alias_kind="pseudonym"),
    )
    alias = next(alias for alias in with_alias.aliases if alias.alias == "Curated Pen Name")
    with_external_id = add_contributor_external_id(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=handle,
        request=ContributorExternalIdCreateRequest(
            authority="wikidata",
            external_key=f"Q{uuid4().int % 100000000}",
        ),
    )
    external_id = next(
        external_id
        for external_id in with_external_id.external_ids
        if external_id.authority == "wikidata"
    )

    after_alias_delete = delete_contributor_alias(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=handle,
        alias_id=alias.id,
    )
    after_external_delete = delete_contributor_external_id(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=handle,
        external_id_id=external_id.id,
    )
    event_types = db_session.execute(
        text(
            """
            SELECT event_type
            FROM contributor_identity_events
            WHERE actor_user_id = :actor_user_id
            ORDER BY created_at ASC, id ASC
            """
        ),
        {"actor_user_id": actor_user_id},
    ).scalars()

    assert all(existing.id != alias.id for existing in after_alias_delete.aliases)
    assert all(existing.id != external_id.id for existing in after_external_delete.external_ids)
    assert set(event_types) >= {
        "alias_add",
        "alias_remove",
        "external_id_add",
        "external_id_remove",
    }


@pytest.mark.integration
def test_contributor_http_routes_mask_private_only_works(auth_client, direct_db):
    owner_id = create_test_user_id()
    outsider_id = create_test_user_id()
    for user_id in (owner_id, outsider_id):
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)

    owner_me = auth_client.get("/me", headers=auth_headers(owner_id))
    assert owner_me.status_code == 200
    default_library_id = UUID(owner_me.json()["data"]["default_library_id"])
    assert auth_client.get("/me", headers=auth_headers(outsider_id)).status_code == 200

    with direct_db.session() as session:
        media_id = create_test_media(session, title=f"HTTP Contributor Work {uuid4()}")
        add_media_to_library(session, default_library_id, media_id)
        replace_media_contributor_credits(
            session,
            media_id=media_id,
            credits=[{"name": "HTTP Visible Author", "role": "author", "source": "manual"}],
        )
        contributor_id, handle, _credit_id = _credit_contributor(session, media_id)
        session.commit()

    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    search_response = auth_client.get(
        "/contributors?q=HTTP+Visible",
        headers=auth_headers(owner_id),
    )
    assert search_response.status_code == 200
    search_rows = search_response.json()["data"]["contributors"]
    assert search_rows[0]["handle"] == handle
    assert search_rows[0]["href"] == f"/authors/{handle}"

    detail_response = auth_client.get(f"/contributors/{handle}", headers=auth_headers(owner_id))
    assert detail_response.status_code == 200
    assert detail_response.json()["data"]["handle"] == handle

    works_response = auth_client.get(
        f"/contributors/{handle}/works",
        headers=auth_headers(owner_id),
    )
    assert works_response.status_code == 200
    works = works_response.json()["data"]["works"]
    assert len(works) == 1
    assert works[0]["route"] == f"/media/{media_id}"

    outsider_detail = auth_client.get(
        f"/contributors/{handle}",
        headers=auth_headers(outsider_id),
    )
    outsider_works = auth_client.get(
        f"/contributors/{handle}/works",
        headers=auth_headers(outsider_id),
    )
    assert outsider_detail.status_code == 404
    assert outsider_detail.json()["error"]["code"] == "E_NOT_FOUND"
    assert outsider_works.status_code == 404
    assert outsider_works.json()["error"]["code"] == "E_NOT_FOUND"


@pytest.mark.integration
def test_contributor_http_tombstone_rejects_active_bylines(auth_client, direct_db):
    curator_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", curator_id)
    direct_db.register_cleanup("libraries", "owner_user_id", curator_id)
    direct_db.register_cleanup("memberships", "user_id", curator_id)
    me_response = auth_client.get("/me", headers=auth_headers(curator_id))
    assert me_response.status_code == 200
    default_library_id = UUID(me_response.json()["data"]["default_library_id"])

    with direct_db.session() as session:
        media_id = create_test_media(session, title=f"HTTP Tombstone Guard {uuid4()}")
        add_media_to_library(session, default_library_id, media_id)
        replace_media_contributor_credits(
            session,
            media_id=media_id,
            credits=[{"name": "HTTP Tombstone Author", "role": "author", "source": "manual"}],
        )
        contributor_id, handle, _credit_id = _credit_contributor(session, media_id)
        session.commit()

    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    response = auth_client.post(
        f"/contributors/{handle}/tombstone",
        headers=auth_headers(curator_id, nexus_roles=["contributor_curator"]),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def _credit_contributor(db_session, media_id):
    return db_session.execute(
        text(
            """
            SELECT c.id, c.handle, cc.id
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()


@pytest.mark.integration
def test_merge_contributors_moves_references_and_writes_event(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    source_media_id = create_test_media(db_session, title=f"Merge Source {uuid4()}")
    target_media_id = create_test_media(db_session, title=f"Merge Target {uuid4()}")
    external_key = f"viaf-{uuid4()}"

    replace_media_contributor_credits(
        db_session,
        media_id=source_media_id,
        credits=[
            {
                "name": "Merge Source",
                "role": "author",
                "source": "test_provider",
                "external_id": {"authority": "viaf", "external_key": external_key},
            }
        ],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=target_media_id,
        credits=[{"name": "Merge Target", "role": "author", "source": "manual"}],
    )
    source_id, source_handle, _source_credit_id = _credit_contributor(
        db_session,
        source_media_id,
    )
    target_id, target_handle, _target_credit_id = _credit_contributor(
        db_session,
        target_media_id,
    )
    conversation_id = create_test_conversation(db_session, actor_user_id)
    message_id = create_test_message(db_session, conversation_id, seq=1)
    db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :source_id, 'media', :media_id, '{}'::jsonb
            )
            """
        ),
        {"user_id": actor_user_id, "source_id": source_id, "media_id": target_media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :target_id, 'media', :media_id, '{}'::jsonb
            )
            """
        ),
        {"user_id": actor_user_id, "target_id": target_id, "media_id": target_media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id, user_id, object_type, object_id, ordinal, context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'contributor',
                :source_id,
                0,
                CAST(:snapshot AS jsonb)
            )
            """
        ),
        {
            "message_id": message_id,
            "user_id": actor_user_id,
            "source_id": source_id,
            "snapshot": '{"objectType":"contributor","label":"Merge Source"}',
        },
    )

    merged = merge_contributors(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        request=ContributorMergeRequest(
            source_handle=source_handle,
            target_handle=target_handle,
        ),
    )

    rows = db_session.execute(
        text(
            """
            SELECT
                (SELECT status FROM contributors WHERE id = :source_id) AS source_status,
                (SELECT merged_into_contributor_id FROM contributors WHERE id = :source_id)
                    AS merged_into,
                (SELECT contributor_id FROM contributor_credits WHERE media_id = :source_media_id)
                    AS moved_credit,
                (SELECT contributor_id FROM contributor_external_ids WHERE external_key = :external_key)
                    AS moved_external_id,
                (SELECT count(*) FROM object_links WHERE a_type = 'contributor' AND b_id = :target_media_id)
                    AS link_count,
                (SELECT a_id FROM object_links WHERE a_type = 'contributor' AND b_id = :target_media_id)
                    AS moved_link,
                (SELECT object_id FROM message_context_items WHERE id IS NOT NULL AND message_id = :message_id)
                    AS moved_context,
                (
                    SELECT count(*)
                    FROM contributor_identity_events
                    WHERE event_type = 'merge'
                      AND source_contributor_id = :source_id
                      AND target_contributor_id = :target_id
                )
                    AS merge_events
            """
        ),
        {
            "source_id": source_id,
            "target_id": target_id,
            "source_media_id": source_media_id,
            "external_key": external_key,
            "target_media_id": target_media_id,
            "message_id": message_id,
        },
    ).one()

    assert merged.handle == target_handle
    assert rows.source_status == "merged"
    assert rows.merged_into == target_id
    assert rows.moved_credit == target_id
    assert rows.moved_external_id == target_id
    assert rows.link_count == 1
    assert rows.moved_link == target_id
    assert rows.moved_context == target_id
    assert rows.merge_events == 1


@pytest.mark.integration
def test_merge_contributors_requires_curator_role_and_leaves_other_user_refs(db_session):
    actor_user_id = uuid4()
    other_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": other_user_id})
    source_media_id = create_test_media(db_session, title=f"Blocked Merge Source {uuid4()}")
    target_media_id = create_test_media(db_session, title=f"Blocked Merge Target {uuid4()}")

    replace_media_contributor_credits(
        db_session,
        media_id=source_media_id,
        credits=[{"name": "Blocked Source", "role": "author", "source": "test_provider"}],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=target_media_id,
        credits=[{"name": "Blocked Target", "role": "author", "source": "manual"}],
    )
    source_id, source_handle, _source_credit_id = _credit_contributor(
        db_session,
        source_media_id,
    )
    target_id, target_handle, _target_credit_id = _credit_contributor(
        db_session,
        target_media_id,
    )
    db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :source_id, 'media', :media_id, '{}'::jsonb
            )
            """
        ),
        {"user_id": other_user_id, "source_id": source_id, "media_id": target_media_id},
    )

    with pytest.raises(ForbiddenError) as error:
        merge_contributors(
            db_session,
            actor_user_id=actor_user_id,
            request=ContributorMergeRequest(
                source_handle=source_handle,
                target_handle=target_handle,
            ),
        )

    rows = db_session.execute(
        text(
            """
            SELECT
                (SELECT status FROM contributors WHERE id = :source_id) AS source_status,
                (SELECT contributor_id FROM contributor_credits WHERE media_id = :source_media_id)
                    AS source_credit,
                (SELECT a_id FROM object_links WHERE user_id = :other_user_id) AS other_link
            """
        ),
        {
            "source_id": source_id,
            "target_id": target_id,
            "source_media_id": source_media_id,
            "other_user_id": other_user_id,
        },
    ).one()

    assert error.value.code == ApiErrorCode.E_FORBIDDEN
    assert rows.source_status == "unverified"
    assert rows.source_credit == source_id
    assert rows.other_link == source_id


@pytest.mark.integration
def test_split_contributor_moves_selected_records_only(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_a = create_test_media(db_session, title=f"Split A {uuid4()}")
    media_b = create_test_media(db_session, title=f"Split B {uuid4()}")
    external_key = f"orcid-{uuid4()}"
    for media_id in (media_a, media_b):
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[
                {
                    "name": "Combined Author",
                    "role": "author",
                    "source": "test_provider",
                    "external_id": {"authority": "orcid", "external_key": external_key},
                }
            ],
        )

    source_id, source_handle, moved_credit_id = _credit_contributor(db_session, media_a)
    _same_source_id, _same_handle, kept_credit_id = _credit_contributor(db_session, media_b)
    conversation_id = create_test_conversation(db_session, actor_user_id)
    message_id = create_test_message(db_session, conversation_id, seq=1)
    link_id = db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :source_id, 'media', :media_id, '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {"user_id": actor_user_id, "source_id": source_id, "media_id": media_a},
    ).scalar_one()
    context_item_id = db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id, user_id, object_type, object_id, ordinal, context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'contributor',
                :source_id,
                0,
                CAST(:snapshot AS jsonb)
            )
            RETURNING id
            """
        ),
        {
            "message_id": message_id,
            "user_id": actor_user_id,
            "source_id": source_id,
            "snapshot": '{"objectType":"contributor","label":"Combined Author"}',
        },
    ).scalar_one()

    split = split_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorSplitRequest(
            display_name="Separated Author",
            credit_ids=[moved_credit_id],
            object_link_ids=[link_id],
            message_context_item_ids=[context_item_id],
        ),
    )
    split_id = db_session.execute(
        text("SELECT id FROM contributors WHERE handle = :handle"),
        {"handle": split.handle},
    ).scalar_one()

    rows = db_session.execute(
        text(
            """
            SELECT
                (SELECT contributor_id FROM contributor_credits WHERE id = :moved_credit_id)
                    AS moved_credit,
                (SELECT contributor_id FROM contributor_credits WHERE id = :kept_credit_id)
                    AS kept_credit,
                (SELECT a_id FROM object_links WHERE id = :link_id) AS moved_link,
                (SELECT object_id FROM message_context_items WHERE id = :context_item_id)
                    AS moved_context,
                (
                    SELECT count(*)
                    FROM contributor_identity_events
                    WHERE event_type = 'split'
                      AND source_contributor_id = :source_id
                      AND target_contributor_id = :split_id
                )
                    AS split_events
            """
        ),
        {
            "moved_credit_id": moved_credit_id,
            "kept_credit_id": kept_credit_id,
            "link_id": link_id,
            "context_item_id": context_item_id,
            "source_id": source_id,
            "split_id": split_id,
        },
    ).one()

    assert rows.moved_credit == split_id
    assert rows.kept_credit == source_id
    assert rows.moved_link == split_id
    assert rows.moved_context == split_id
    assert rows.split_events == 1


@pytest.mark.integration
def test_split_contributor_rejects_other_users_object_links(db_session):
    actor_user_id = uuid4()
    other_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": other_user_id})
    media_id = create_test_media(db_session, title=f"Split Ownership {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Shared Author", "role": "author", "source": "manual"}],
    )
    source_id, source_handle, credit_id = _credit_contributor(db_session, media_id)
    other_link_id = db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :source_id, 'media', :media_id, '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {"user_id": other_user_id, "source_id": source_id, "media_id": media_id},
    ).scalar_one()

    with pytest.raises(ApiError) as error:
        split_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=source_handle,
            request=ContributorSplitRequest(
                display_name="Moved Author",
                credit_ids=[credit_id],
                object_link_ids=[other_link_id],
            ),
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    rows = db_session.execute(
        text(
            """
            SELECT
                (SELECT a_id FROM object_links WHERE id = :link_id) AS link_contributor_id,
                (SELECT contributor_id FROM contributor_credits WHERE id = :credit_id)
                    AS credit_contributor_id,
                (SELECT count(*) FROM contributors WHERE display_name = 'Moved Author')
                    AS moved_author_count
            """
        ),
        {"link_id": other_link_id, "credit_id": credit_id},
    ).one()

    assert rows.link_contributor_id == source_id
    assert rows.credit_contributor_id == source_id
    assert rows.moved_author_count == 0


@pytest.mark.integration
def test_split_contributor_rejects_other_users_context_items_before_mutation(db_session):
    actor_user_id = uuid4()
    other_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": other_user_id})
    media_id = create_test_media(db_session, title=f"Split Context Ownership {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Shared Context Author", "role": "author", "source": "manual"}],
    )
    source_id, source_handle, credit_id = _credit_contributor(db_session, media_id)
    conversation_id = create_test_conversation(db_session, other_user_id)
    message_id = create_test_message(db_session, conversation_id, seq=1)
    other_context_item_id = db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id, user_id, object_type, object_id, ordinal, context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'contributor',
                :source_id,
                0,
                CAST(:snapshot AS jsonb)
            )
            RETURNING id
            """
        ),
        {
            "message_id": message_id,
            "user_id": other_user_id,
            "source_id": source_id,
            "snapshot": '{"objectType":"contributor","label":"Shared Context Author"}',
        },
    ).scalar_one()

    with pytest.raises(ApiError) as error:
        split_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=source_handle,
            request=ContributorSplitRequest(
                display_name="Moved Context Author",
                credit_ids=[credit_id],
                message_context_item_ids=[other_context_item_id],
            ),
        )

    rows = db_session.execute(
        text(
            """
            SELECT
                (SELECT object_id FROM message_context_items WHERE id = :context_item_id)
                    AS context_contributor_id,
                (SELECT contributor_id FROM contributor_credits WHERE id = :credit_id)
                    AS credit_contributor_id,
                (SELECT count(*) FROM contributors WHERE display_name = 'Moved Context Author')
                    AS moved_author_count
            """
        ),
        {"context_item_id": other_context_item_id, "credit_id": credit_id},
    ).one()

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert rows.context_contributor_id == source_id
    assert rows.credit_contributor_id == source_id
    assert rows.moved_author_count == 0


@pytest.mark.integration
def test_split_contributor_requires_curator_role(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Blocked Split {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Blocked Split Author", "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, credit_id = _credit_contributor(db_session, media_id)

    with pytest.raises(ForbiddenError) as error:
        split_contributor(
            db_session,
            actor_user_id=actor_user_id,
            contributor_handle=handle,
            request=ContributorSplitRequest(
                display_name="Unauthorized Split",
                credit_ids=[credit_id],
            ),
        )

    assert error.value.code == ApiErrorCode.E_FORBIDDEN


@pytest.mark.integration
def test_tombstone_rejects_active_credit_references(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Tombstone {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Tombstoned Author", "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    with pytest.raises(ApiError) as error:
        tombstone_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=handle,
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert get_contributor_by_handle(db_session, handle).handle == handle


@pytest.mark.integration
def test_tombstone_rejects_object_link_references(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Tombstone Object Link {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Linked Tombstone Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO object_links (
                user_id, relation_type, a_type, a_id, b_type, b_id, metadata
            )
            VALUES (
                :user_id, 'related', 'contributor', :contributor_id, 'media', :media_id,
                '{}'::jsonb
            )
            """
        ),
        {"user_id": actor_user_id, "contributor_id": contributor_id, "media_id": media_id},
    )

    with pytest.raises(ApiError) as error:
        tombstone_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=handle,
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert get_contributor_by_handle(db_session, handle).handle == handle


@pytest.mark.integration
def test_tombstone_rejects_message_context_references(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Tombstone Context {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Context Tombstone Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )
    conversation_id = create_test_conversation(db_session, actor_user_id)
    message_id = create_test_message(db_session, conversation_id, seq=1)
    db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id, user_id, object_type, object_id, ordinal, context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'contributor',
                :contributor_id,
                0,
                CAST(:snapshot AS jsonb)
            )
            """
        ),
        {
            "message_id": message_id,
            "user_id": actor_user_id,
            "contributor_id": contributor_id,
            "snapshot": '{"objectType":"contributor","label":"Context Tombstone Author"}',
        },
    )

    with pytest.raises(ApiError) as error:
        tombstone_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=handle,
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert get_contributor_by_handle(db_session, handle).handle == handle


@pytest.mark.integration
def test_tombstone_rejects_persisted_contributor_refs(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Tombstone Persisted Ref {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Persisted Ref Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )
    conversation_id = create_test_conversation(db_session, actor_user_id)
    user_message_id = create_test_message(db_session, conversation_id, seq=1)
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
    )
    tool_call_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id,
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                scope,
                status
            )
            VALUES (
                :tool_call_id,
                :conversation_id,
                :user_message_id,
                :assistant_message_id,
                'app_search',
                0,
                'all',
                'complete'
            )
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                tool_call_id,
                ordinal,
                result_type,
                source_id,
                context_ref,
                result_ref
            )
            VALUES (
                :tool_call_id,
                0,
                'contributor',
                :source_id,
                CAST(:context_ref AS jsonb),
                CAST(:result_ref AS jsonb)
            )
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "source_id": f"contributor:{handle}",
            "context_ref": f'{{"type":"contributor","id":"contributor:{handle}"}}',
            "result_ref": (
                '{"result_type":"contributor",'
                f'"source_id":"contributor:{handle}",'
                f'"context_ref":{{"type":"contributor","id":"contributor:{handle}"}}}}'
            ),
        },
    )

    with pytest.raises(ApiError) as error:
        tombstone_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=handle,
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert get_contributor_by_handle(db_session, handle).handle == handle


@pytest.mark.integration
def test_tombstone_hides_unreferenced_contributor_from_normal_reads(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Unreferenced Tombstone {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Unreferenced Tombstone Author", "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )

    tombstoned = tombstone_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=handle,
    )

    assert tombstoned.status == "tombstoned"
    with pytest.raises(NotFoundError):
        get_contributor_by_handle(db_session, handle)


@pytest.mark.integration
def test_tombstone_contributor_requires_curator_role(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    media_id = create_test_media(db_session, title=f"Blocked Tombstone {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Blocked Tombstone Author", "role": "author", "source": "manual"}],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    with pytest.raises(ForbiddenError) as error:
        tombstone_contributor(db_session, actor_user_id=actor_user_id, contributor_handle=handle)

    assert error.value.code == ApiErrorCode.E_FORBIDDEN
    assert get_contributor_by_handle(db_session, handle).handle == handle
