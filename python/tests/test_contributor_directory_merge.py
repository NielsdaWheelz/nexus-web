"""Integration coverage for contributor merge + the faceted authors directory.

Exercises the public ``nexus.services.contributors`` contracts (``merge_contributor``,
``list_contributors``, ``get_contributor_by_handle``, ``resolve_canonical_contributor_ids``)
plus merge-aware search filtering. Assertions go through service return values and targeted
raw SQL on the database — never internal event-payload key names.
"""

import base64
import json
from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.contributors import ContributorMergeRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.contributor_taxonomy import normalize_contributor_name
from nexus.services.contributors import (
    get_contributor_by_handle,
    list_contributors,
    merge_contributor,
    resolve_canonical_contributor_ids,
)
from nexus.services.search import search
from nexus.services.search.query import SearchQuery
from tests.factories import (
    add_media_to_library,
    create_test_media,
    create_test_media_in_library,
)

CURATOR_ROLES = frozenset({"contributor_curator"})


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


def _mint_contributor(db_session, *, display_name, source="manual", role="author"):
    """Create a visible contributor by crediting a fresh in-library media work.

    Returns ``(contributor_id, handle, media_id, library_id, viewer_id)``.
    """
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"{display_name} Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": display_name, "role": role, "source": source}],
    )
    contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)
    return contributor_id, handle, media_id, library_id, viewer_id


# ---------------------------------------------------------------------------
# merge_contributor
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_merge_repoints_credits_and_tombstones_source(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    source_id, source_handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Merge Source {uuid4()}"
    )
    target_id, target_handle, _t_media, _t_lib, _t_viewer = _mint_contributor(
        db_session, display_name=f"Merge Target {uuid4()}"
    )

    merged = merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    assert merged.handle == target_handle

    source_credit_count = db_session.execute(
        text("SELECT count(*) FROM contributor_credits WHERE contributor_id = :id"),
        {"id": source_id},
    ).scalar_one()
    target_credit_count = db_session.execute(
        text("SELECT count(*) FROM contributor_credits WHERE contributor_id = :id"),
        {"id": target_id},
    ).scalar_one()
    assert source_credit_count == 0
    assert target_credit_count == 2

    source_row = db_session.execute(
        text(
            """
            SELECT status, merged_into_contributor_id, merged_at IS NOT NULL AS has_merged_at
            FROM contributors
            WHERE id = :id
            """
        ),
        {"id": source_id},
    ).one()
    assert source_row.status == "merged"
    assert source_row.merged_into_contributor_id == target_id
    assert source_row.has_merged_at is True

    event_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributor_identity_events
            WHERE event_type = 'merge'
              AND source_contributor_id = :source_id
              AND target_contributor_id = :target_id
            """
        ),
        {"source_id": source_id, "target_id": target_id},
    ).scalar_one()
    assert event_count == 1


@pytest.mark.integration
def test_merge_dedupes_identical_credit_on_same_work(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    media_id = create_test_media(db_session, title=f"Shared Merge Work {uuid4()}")
    duplicate_name = f"Duplicate Byline {uuid4()}"

    # Two different-source credits on the SAME media with the SAME name resolve to two
    # distinct contributors (name-only credits never auto-merge across providers).
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "manual"}],
        source="manual",
    )

    credit_rows = db_session.execute(
        text(
            """
            SELECT cc.contributor_id, cc.source
            FROM contributor_credits cc
            WHERE cc.media_id = :media_id
            ORDER BY cc.source
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    assert len(credit_rows) == 2
    source_id = credit_rows[0].contributor_id  # 'manual'
    target_id = credit_rows[1].contributor_id  # 'rss'
    assert source_id != target_id

    source_handle = db_session.execute(
        text("SELECT handle FROM contributors WHERE id = :id"),
        {"id": source_id},
    ).scalar_one()
    target_handle = db_session.execute(
        text("SELECT handle FROM contributors WHERE id = :id"),
        {"id": target_id},
    ).scalar_one()

    normalized = normalize_contributor_name(duplicate_name)
    merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    surviving = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributor_credits
            WHERE contributor_id = :target_id
              AND media_id = :media_id
              AND role = 'author'
              AND normalized_credited_name = :normalized
            """
        ),
        {"target_id": target_id, "media_id": media_id, "normalized": normalized},
    ).scalar_one()
    assert surviving == 1


@pytest.mark.integration
def test_merge_writes_confirmed_alias_that_resolves_name_only_reingest(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    source_display = f"Aliasing Source {uuid4()}"
    source_id, source_handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=source_display
    )
    target_id, target_handle, _t_media, _t_lib, _t_viewer = _mint_contributor(
        db_session, display_name=f"Aliasing Target {uuid4()}"
    )

    merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    normalized_source = normalize_contributor_name(source_display)
    merge_alias = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM contributor_aliases
            WHERE contributor_id = :target_id
              AND normalized_alias = :normalized
              AND source = 'merge'
            """
        ),
        {"target_id": target_id, "normalized": normalized_source},
    ).scalar_one()
    assert merge_alias == 1

    # Name-only reingest of the source's display name resolves to the TARGET (AC9).
    reingest_media = create_test_media(db_session, title=f"Reingest Work {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=reingest_media,
        credits=[{"name": source_display, "role": "author", "source": "rss"}],
    )
    reingest_contributor_id = db_session.execute(
        text("SELECT contributor_id FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": reingest_media},
    ).scalar_one()
    assert reingest_contributor_id == target_id
    assert reingest_contributor_id != source_id


@pytest.mark.integration
def test_merged_source_handle_resolves_to_survivor(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    source_id, source_handle, source_media, source_lib, viewer_id = _mint_contributor(
        db_session, display_name=f"Resolve Source {uuid4()}"
    )
    target_id, target_handle, _t_media, _t_lib, _t_viewer = _mint_contributor(
        db_session, display_name=f"Resolve Target {uuid4()}"
    )
    # Make the target visible to the source's viewer so the canonical read succeeds.
    target_media = create_test_media(db_session, title=f"Resolve Target Visible {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=target_media,
        credits=[{"name": "ignored", "role": "author", "source": "manual"}],
    )
    db_session.execute(
        text("UPDATE contributor_credits SET contributor_id = :target_id WHERE media_id = :media"),
        {"target_id": target_id, "media": target_media},
    )
    add_media_to_library(db_session, source_lib, target_media)
    db_session.commit()

    merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    # Reopening the merged source handle resolves to the survivor (AC6).
    resolved = get_contributor_by_handle(db_session, source_handle, viewer_id)
    assert resolved.handle == target_handle

    assert resolve_canonical_contributor_ids(db_session, [source_handle]) == [target_id]
    assert source_id != target_id


@pytest.mark.integration
def test_search_by_merged_handle_returns_target_works(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)

    # Target gets a visible media work.
    target_media = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Target Searchable Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=target_media,
        credits=[{"name": f"Search Target {uuid4()}", "role": "author", "source": "manual"}],
    )
    target_id, target_handle, _credit = _credit_contributor(db_session, target_media)

    # Source is a separate contributor (its own throwaway media), merged into the target.
    _source_id, source_handle, _s_media, _s_lib, _s_viewer = _mint_contributor(
        db_session, display_name=f"Search Source {uuid4()}"
    )

    merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    response = search(
        db_session,
        viewer_id=viewer_id,
        query=SearchQuery(
            text="",
            result_types=("media",),
            authors=(source_handle,),
        ),
    )

    media_ids = {
        result.media_id for result in response.results if getattr(result, "type", None) == "media"
    }
    assert target_media in media_ids
    assert target_id is not None


@pytest.mark.integration
def test_merge_rejects_self_merge(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    _contributor_id, handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Self Merge {uuid4()}"
    )

    with pytest.raises(ApiError) as error:
        merge_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=handle,
            request=ContributorMergeRequest(target_handle=handle),
        )
    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.integration
def test_merge_rejects_already_merged_source(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    _source_id, source_handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Twice Merge Source {uuid4()}"
    )
    _target_id, target_handle, _t_media, _t_lib, _t_viewer = _mint_contributor(
        db_session, display_name=f"Twice Merge Target {uuid4()}"
    )
    _third_id, third_handle, _x_media, _x_lib, _x_viewer = _mint_contributor(
        db_session, display_name=f"Twice Merge Third {uuid4()}"
    )

    merge_contributor(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
    )

    with pytest.raises(ApiError) as error:
        merge_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=source_handle,
            request=ContributorMergeRequest(target_handle=third_handle),
        )
    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.integration
def test_merge_missing_handle_raises_not_found(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    _target_id, target_handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Missing Merge Target {uuid4()}"
    )

    with pytest.raises(NotFoundError) as error:
        merge_contributor(
            db_session,
            actor_user_id=actor_user_id,
            actor_roles=CURATOR_ROLES,
            contributor_handle=f"does-not-exist-{uuid4().hex}",
            request=ContributorMergeRequest(target_handle=target_handle),
        )
    assert error.value.code == ApiErrorCode.E_NOT_FOUND


@pytest.mark.integration
def test_merge_requires_curator_role(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})
    _source_id, source_handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Gated Merge Source {uuid4()}"
    )
    _target_id, target_handle, _t_media, _t_lib, _t_viewer = _mint_contributor(
        db_session, display_name=f"Gated Merge Target {uuid4()}"
    )

    with pytest.raises(ForbiddenError) as error:
        merge_contributor(
            db_session,
            actor_user_id=actor_user_id,
            contributor_handle=source_handle,
            request=ContributorMergeRequest(target_handle=target_handle),
        )
    assert error.value.code == ApiErrorCode.E_FORBIDDEN


# ---------------------------------------------------------------------------
# list_contributors (faceted directory)
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_directory_hides_contributor_without_visible_credit(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media(db_session, title=f"Hidden Directory Work {uuid4()}")
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {"name": f"Hidden Directory Author {uuid4()}", "role": "author", "source": "manual"}
        ],
    )
    _contributor_id, handle, _credit_id = _credit_contributor(db_session, media_id)

    before = list_contributors(db_session, viewer_id=viewer_id)
    assert handle not in {entry.handle for entry in before.entries}

    add_media_to_library(db_session, library_id, media_id)
    db_session.commit()

    after = list_contributors(db_session, viewer_id=viewer_id)
    matching = [entry for entry in after.entries if entry.handle == handle]
    assert len(matching) == 1
    assert matching[0].work_count == 1


@pytest.mark.integration
def test_directory_work_count_is_visibility_scoped(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    display_name = f"Two Work Author {uuid4()}"

    media_a = create_test_media_in_library(
        db_session, viewer_id, library_id, title=f"Two Work A {uuid4()}"
    )
    media_b = create_test_media_in_library(
        db_session, viewer_id, library_id, title=f"Two Work B {uuid4()}"
    )
    for media_id in (media_a, media_b):
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[{"name": display_name, "role": "author", "source": "manual"}],
        )
        # Pin both credits to the same contributor (manual name-only credits otherwise diverge).
        contributor_id, handle, _credit = _credit_contributor(db_session, media_a)
        db_session.execute(
            text("UPDATE contributor_credits SET contributor_id = :cid WHERE media_id = :media"),
            {"cid": contributor_id, "media": media_id},
        )
    db_session.commit()

    contributor_id, handle, _credit = _credit_contributor(db_session, media_a)
    page = list_contributors(db_session, viewer_id=viewer_id)
    matching = [entry for entry in page.entries if entry.handle == handle]
    assert len(matching) == 1
    assert matching[0].work_count == 2


@pytest.mark.integration
@pytest.mark.parametrize("sort", ["name", "works"])
def test_directory_paginates_without_overlap(db_session, sort):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)

    handles: set[str] = set()
    for index in range(3):
        # Distinct sort_names (A/B/C prefix) and distinct work counts (1/2/3 works).
        display_name = f"{chr(ord('A') + index)} Page Author {uuid4()}"
        first_media = create_test_media_in_library(
            db_session, viewer_id, library_id, title=f"Page Work {index}-0 {uuid4()}"
        )
        replace_media_contributor_credits(
            db_session,
            media_id=first_media,
            credits=[{"name": display_name, "role": "author", "source": "manual"}],
        )
        contributor_id, handle, _credit = _credit_contributor(db_session, first_media)
        handles.add(handle)
        for extra in range(index):
            extra_media = create_test_media_in_library(
                db_session,
                viewer_id,
                library_id,
                title=f"Page Work {index}-{extra + 1} {uuid4()}",
            )
            replace_media_contributor_credits(
                db_session,
                media_id=extra_media,
                credits=[{"name": display_name, "role": "author", "source": "manual"}],
            )
            db_session.execute(
                text(
                    "UPDATE contributor_credits SET contributor_id = :cid WHERE media_id = :media"
                ),
                {"cid": contributor_id, "media": extra_media},
            )
    db_session.commit()

    first_page = list_contributors(db_session, viewer_id=viewer_id, sort=sort, limit=2)
    assert first_page.page.has_more is True
    assert first_page.page.next_cursor is not None
    assert len(first_page.entries) == 2

    second_page = list_contributors(
        db_session,
        viewer_id=viewer_id,
        sort=sort,
        limit=2,
        cursor=first_page.page.next_cursor,
    )

    first_handles = {entry.handle for entry in first_page.entries}
    second_handles = {entry.handle for entry in second_page.entries}
    assert first_handles.isdisjoint(second_handles)
    assert handles <= (first_handles | second_handles)


@pytest.mark.integration
def test_directory_facets_count_roles_and_filter_narrows(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)

    author_handles: set[str] = set()
    for _ in range(2):
        media_id = create_test_media_in_library(
            db_session, viewer_id, library_id, title=f"Facet Author Work {uuid4()}"
        )
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[{"name": f"Facet Author {uuid4()}", "role": "author", "source": "manual"}],
        )
        _cid, handle, _credit = _credit_contributor(db_session, media_id)
        author_handles.add(handle)

    editor_media = create_test_media_in_library(
        db_session, viewer_id, library_id, title=f"Facet Editor Work {uuid4()}"
    )
    replace_media_contributor_credits(
        db_session,
        media_id=editor_media,
        credits=[{"name": f"Facet Editor {uuid4()}", "role": "editor", "source": "manual"}],
    )
    _editor_cid, editor_handle, _editor_credit = _credit_contributor(db_session, editor_media)
    db_session.commit()

    page = list_contributors(db_session, viewer_id=viewer_id)
    role_facets = {facet.value: facet.count for facet in page.facets.roles}
    assert role_facets.get("author") == 2
    assert role_facets.get("editor") == 1

    narrowed = list_contributors(db_session, viewer_id=viewer_id, roles=frozenset({"author"}))
    narrowed_handles = {entry.handle for entry in narrowed.entries}
    assert author_handles <= narrowed_handles
    assert editor_handle not in narrowed_handles


@pytest.mark.integration
def test_directory_rejects_garbage_cursor(db_session):
    viewer_id = uuid4()
    ensure_user_and_default_library(db_session, viewer_id)

    with pytest.raises(ApiError) as error:
        list_contributors(db_session, viewer_id=viewer_id, cursor="!!!")
    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.integration
def test_directory_rejects_cross_mode_and_malformed_cursor(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    for index in range(2):
        media_id = create_test_media_in_library(
            db_session, viewer_id, library_id, title=f"Cursor Mode Work {index} {uuid4()}"
        )
        replace_media_contributor_credits(
            db_session,
            media_id=media_id,
            credits=[
                {
                    "name": f"{chr(ord('A') + index)} Cursor Author {uuid4()}",
                    "role": "author",
                    "source": "manual",
                }
            ],
        )
    db_session.commit()

    works_cursor = list_contributors(
        db_session, viewer_id=viewer_id, sort="works", limit=1
    ).page.next_cursor
    assert works_cursor is not None

    # A cursor minted for one sort mode is rejected by the other (mode-mixing corrupts paging).
    with pytest.raises(ApiError) as cross_mode:
        list_contributors(db_session, viewer_id=viewer_id, sort="name", cursor=works_cursor)
    assert cross_mode.value.code == ApiErrorCode.E_INVALID_REQUEST

    # A right-mode but structurally malformed (tampered) cursor is a typed 400, not a 500.
    malformed = base64.urlsafe_b64encode(json.dumps({"k": "name"}).encode()).decode()
    with pytest.raises(ApiError) as bad_shape:
        list_contributors(db_session, viewer_id=viewer_id, sort="name", cursor=malformed)
    assert bad_shape.value.code == ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.integration
def test_object_link_only_contributor_appears_in_directory_and_search(db_session):
    """AC4 / R6: a contributor with no visible credit but a viewer object link is present in
    the directory (work_count 0) AND in unscoped search — the unified visibility predicate."""
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    # Distinctive coined token so the FTS query below matches only this contributor.
    distinctive = f"Quixotryx{uuid4().hex[:8]}"
    media_id = create_test_media_in_library(
        db_session, viewer_id, library_id, title=f"Pinned Author Work {uuid4()}"
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": f"{distinctive} Author", "role": "author", "source": "manual"}],
    )
    contributor_id, handle, _credit = _credit_contributor(db_session, media_id)
    # Drop the credit so the contributor is reachable ONLY through a viewer-owned object link.
    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :id"),
        {"id": contributor_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO object_links (user_id, relation_type, a_type, a_id, b_type, b_id, metadata)
            VALUES (:user_id, 'related', 'contributor', :cid, 'media', :media_id, '{}'::jsonb)
            """
        ),
        {"user_id": viewer_id, "cid": contributor_id, "media_id": media_id},
    )
    db_session.commit()

    directory = [
        entry
        for entry in list_contributors(db_session, viewer_id=viewer_id).entries
        if entry.handle == handle
    ]
    assert len(directory) == 1
    assert directory[0].work_count == 0

    # R6: the object-link-only contributor is now findable by unscoped FTS search (it was
    # previously excluded). Contributor search is query-driven, so search by its name.
    response = search(
        db_session,
        viewer_id=viewer_id,
        query=SearchQuery(text=distinctive, result_types=("contributor",)),
    )
    search_handles = {getattr(result, "contributor_handle", None) for result in response.results}
    assert handle in search_handles


@pytest.mark.integration
def test_resolve_canonical_contributor_ids_drops_unknown_handles(db_session):
    """Unknown handles are dropped, so an all-unknown filter resolves to [] (match nothing),
    never None (match everything) — the load-bearing search filter distinction."""
    contributor_id, handle, _media, _lib, _viewer = _mint_contributor(
        db_session, display_name=f"Canonical Known {uuid4()}"
    )
    db_session.commit()

    assert resolve_canonical_contributor_ids(db_session, [f"missing-{uuid4().hex}"]) == []
    resolved = resolve_canonical_contributor_ids(db_session, [handle, f"missing-{uuid4().hex}"])
    assert resolved == [contributor_id]


# Identity-write SERIALIZABLE + bounded-retry semantics (AC7) are owned by
# nexus.db.retries.retry_serializable and pinned in tests/test_db_retries.py.
