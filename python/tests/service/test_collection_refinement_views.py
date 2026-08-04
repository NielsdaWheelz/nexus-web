"""Proof: every advertised collection index view is one total real-PostgreSQL
order that its own cursor pages exactly, and a cursor is usable only inside the
exact binding that minted it.

Risk: these indexes are drained page by page. If ORDER BY, the keyset predicate,
and the cursor disagree on any key — a tie broken differently, a direction
applied to the wrong key, a missing-rank key that reverses with its value key, a
presented value that is not the sort key — the client silently loses or repeats
rows, and a cursor replayed under another view, revision, scope, resource, or
viewer addresses a page that never existed. Library entries share the extracted
`collection_keyset` mechanism with these indexes, so its page equality is proved
here too: a NULL-unsafe equality in that one module would silently truncate
every listing whose plan carries a nullable key.

The oracle is the collection-refinement cutover's `Ordering And Cursor Rules`
and its valid-pair table, applied by hand to the seeded rows below. Every
asserted text comparison is decided by distinct first letters, so the expected
order does not depend on the server's collation. The one deliberate exception is
the partial-ISO `date_key` pair `1899` / `1899-05-02`: `date_key` is TEXT, and a
shorter prefix sorts first under every candidate collation.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    Contributor,
    Conversation,
    Library,
    Media,
    MediaKind,
    Page,
    ProcessingStatus,
)
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.notes import CreatePageRequest
from nexus.services import contributors as contributors_service
from nexus.services import conversations as conversations_service
from nexus.services import library_governance
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.collection_revisions import CollectionFamily
from nexus.services.contributor_taxonomy import (
    ContributorHandle,
    RawCreditEntry,
    assume_contributor_handle,
    build_observation,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.notes import create_page
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    encode_signed_keyset_cursor,
)
from tests.testkit.auth import UserRecord

# One row per page must exhaust each seeded index well inside this bound; a
# cursor that stops advancing would otherwise loop forever.
_MAX_DRAINED_PAGES = 20

_CHAT_ALPHA = UUID("aaaaaaaa-0000-4000-8000-000000000001")
_CHAT_CAFE = UUID("aaaaaaaa-0000-4000-8000-000000000002")
_CHAT_NAIVE = UUID("aaaaaaaa-0000-4000-8000-000000000003")
_CHAT_SHARED_NEWER = UUID("aaaaaaaa-0000-4000-8000-000000000004")
_CHAT_SHARED_OLDER = UUID("aaaaaaaa-0000-4000-8000-000000000005")
_CHAT_ZULU = UUID("aaaaaaaa-0000-4000-8000-000000000006")

_LIBRARY_BETA = UUID("bbbbbbbb-0000-4000-8000-000000000001")
_LIBRARY_DELTA_FIRST = UUID("bbbbbbbb-0000-4000-8000-000000000002")
_LIBRARY_DELTA_SECOND = UUID("bbbbbbbb-0000-4000-8000-000000000003")
_LIBRARY_ZURICH = UUID("bbbbbbbb-0000-4000-8000-000000000004")

_PAGE_ALPHA = UUID("cccccccc-0000-4000-8000-000000000001")
_PAGE_CAFE = UUID("cccccccc-0000-4000-8000-000000000002")
_PAGE_SHARED_NEWER = UUID("cccccccc-0000-4000-8000-000000000003")
_PAGE_SHARED_OLDER = UUID("cccccccc-0000-4000-8000-000000000004")
_PAGE_ZULU = UUID("cccccccc-0000-4000-8000-000000000005")

# Author-works rows. Only the last hex digit differs, so the outward
# `/media/<id>` href — the works plan's final key — orders by that digit alone.
_WORK_ATLAS = UUID("dddddddd-0000-4000-8000-000000000001")
_WORK_BEACON = UUID("dddddddd-0000-4000-8000-000000000002")
_WORK_CAIRN = UUID("dddddddd-0000-4000-8000-000000000003")
_WORK_DELTA_FIRST = UUID("dddddddd-0000-4000-8000-000000000004")
_WORK_DELTA_SECOND = UUID("dddddddd-0000-4000-8000-000000000005")
_WORK_FACADE = UUID("dddddddd-0000-4000-8000-000000000006")
_WORK_ZEPHYR = UUID("dddddddd-0000-4000-8000-000000000007")
_WORK_REVISION_BUMP = UUID("dddddddd-0000-4000-8000-000000000008")
_OTHER_AUTHOR_WORK_FIRST = UUID("dddddddd-0000-4000-8000-000000000011")
_OTHER_AUTHOR_WORK_SECOND = UUID("dddddddd-0000-4000-8000-000000000012")
_STRANGER_WORK_FIRST = UUID("dddddddd-0000-4000-8000-000000000021")
_STRANGER_WORK_SECOND = UUID("dddddddd-0000-4000-8000-000000000022")

_AUTHOR_NAME = "Wren Halloway"
_OTHER_AUTHOR_NAME = "Perry Odell"

_ENTRY_ALMANAC = UUID("eeeeeeee-0000-4000-8000-000000000001")
_ENTRY_BULLETIN = UUID("eeeeeeee-0000-4000-8000-000000000002")
_ENTRY_CANTO_DATED = UUID("eeeeeeee-0000-4000-8000-000000000003")
_ENTRY_CANTO_UNDATED = UUID("eeeeeeee-0000-4000-8000-000000000004")
_ENTRY_MOTIF = UUID("eeeeeeee-0000-4000-8000-000000000005")
_ENTRY_ZODIAC = UUID("eeeeeeee-0000-4000-8000-000000000006")


def _seed_chats(db: Session, *, viewer_id: UUID) -> None:
    """Six owned chats: a duplicate title, a duplicate updated instant, and two
    non-ASCII titles. Written through the ORM because the chat owner stamps
    ``now()`` and derives its own title, so colliding keys and exact historical
    instants are unreachable through it."""
    for chat_id, title, updated_at in (
        (_CHAT_ALPHA, "alpha draft", datetime(2026, 1, 5, tzinfo=UTC)),
        (_CHAT_CAFE, "café résumé", datetime(2026, 1, 4, tzinfo=UTC)),
        (_CHAT_NAIVE, "naïve björk", datetime(2026, 1, 3, tzinfo=UTC)),
        (_CHAT_SHARED_NEWER, "shared title", datetime(2026, 1, 2, tzinfo=UTC)),
        (_CHAT_SHARED_OLDER, "shared title", datetime(2026, 1, 1, tzinfo=UTC)),
        (_CHAT_ZULU, "zulu", datetime(2026, 1, 2, tzinfo=UTC)),
    ):
        db.add(
            Conversation(
                id=chat_id,
                owner_user_id=viewer_id,
                title=title,
                updated_at=updated_at,
            )
        )
    db.flush()


def _seed_libraries(db: Session, *, viewer_id: UUID) -> None:
    """Four authored Libraries beside the viewer's Default: a duplicate name, a
    non-ASCII name, and exact creation instants. ``created_at`` is written
    directly because the create owner always stamps the transaction instant."""
    for library_id, name, created_at in (
        (_LIBRARY_BETA, "beta shelf", datetime(2026, 1, 3, tzinfo=UTC)),
        (_LIBRARY_DELTA_FIRST, "delta shelf", datetime(2026, 1, 1, tzinfo=UTC)),
        (_LIBRARY_DELTA_SECOND, "delta shelf", datetime(2026, 1, 2, tzinfo=UTC)),
        (_LIBRARY_ZURICH, "zürich shelf", datetime(2026, 1, 4, tzinfo=UTC)),
    ):
        library_governance.create_library(
            db,
            viewer_id,
            CreateLibraryRequest(library_id=library_id, name=name),
        )
        library = db.get(Library, library_id)
        assert library is not None, f"seeded Library {library_id} was not persisted"
        library.created_at = created_at
    db.flush()


def _seed_pages(db: Session, *, viewer_id: UUID) -> None:
    """Five owned Pages with a duplicate title, a duplicate updated instant, and
    a non-ASCII title."""
    for page_id, title, updated_at in (
        (_PAGE_ALPHA, "alpha page", datetime(2026, 1, 5, tzinfo=UTC)),
        (_PAGE_CAFE, "café page", datetime(2026, 1, 4, tzinfo=UTC)),
        (_PAGE_SHARED_NEWER, "shared page", datetime(2026, 1, 2, tzinfo=UTC)),
        (_PAGE_SHARED_OLDER, "shared page", datetime(2026, 1, 1, tzinfo=UTC)),
        (_PAGE_ZULU, "zulu page", datetime(2026, 1, 2, tzinfo=UTC)),
    ):
        create_page(db, viewer_id, CreatePageRequest(page_id=page_id, title=title))
        page = db.get(Page, page_id)
        assert page is not None, f"seeded Page {page_id} was not persisted"
        page.updated_at = updated_at
    db.flush()


def _file_media(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    title: str,
    published_date: str | None,
    created_at: datetime | None = None,
) -> None:
    """One Media filed in ``viewer_id``'s Default Library through the filing owner.

    ``published_date`` is TEXT because sources supply partial ISO dates, and
    ``created_at`` is written directly because the insert stamps the transaction
    instant, so exact and colliding membership instants are unreachable through
    the owner.
    """
    media = Media(
        id=media_id,
        kind=MediaKind.web_article.value,
        title=title,
        published_date=published_date,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    if created_at is not None:
        media.created_at = created_at
    db.add(media)
    db.flush()
    assert ensure_media_in_default_library(db, viewer_id, media_id), (
        f"seeded Media {media_id} was already filed in {viewer_id}'s Default Library"
    )


def _credit_work(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    title: str,
    published_date: str | None,
    author_name: str,
) -> None:
    """One visible Media work credited to ``author_name`` through the author
    facade's in-transaction observation seam."""
    _file_media(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        title=title,
        published_date=published_date,
    )
    observation, _truncated = build_observation(
        {"author": (RawCreditEntry(credited_name=author_name),)}
    )
    contributors_service.apply_observed_role_slices_in_current_transaction(
        db,
        target=contributors_service.MediaTarget(media_id),
        observation=observation,
        source="web_article_byline",
    )
    db.flush()


def _contributor_handle(db: Session, display_name: str) -> ContributorHandle:
    """The handle the identity owner minted for a seeded contributor."""
    handle = db.scalar(select(Contributor.handle).where(Contributor.display_name == display_name))
    assert handle is not None, f"seeded contributor {display_name!r} was not persisted"
    return assume_contributor_handle(str(handle))


def _seed_author_works(db: Session, *, viewer_id: UUID) -> ContributorHandle:
    """Seven visible works for one author, covering every ordering rule unique to
    this surface: three works with no publication date, two works sharing a
    `date_key`, two works sharing a title AND a missing date (so only the outward
    href separates them), a non-ASCII title, and a partial-ISO `date_key` beside
    a full one."""
    for media_id, title, published_date in (
        (_WORK_ATLAS, "atlas of tides", "2001-03-04"),
        (_WORK_BEACON, "beacon notes", "1899-05-02"),
        (_WORK_CAIRN, "cairn survey", "1899"),
        (_WORK_DELTA_FIRST, "delta echo", None),
        (_WORK_DELTA_SECOND, "delta echo", None),
        (_WORK_FACADE, "façade études", "2001-03-04"),
        (_WORK_ZEPHYR, "zephyr log", None),
    ):
        _credit_work(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            title=title,
            published_date=published_date,
            author_name=_AUTHOR_NAME,
        )
    return _contributor_handle(db, _AUTHOR_NAME)


def _seed_second_author_works(db: Session, *, viewer_id: UUID) -> ContributorHandle:
    """Two visible works for a second author the same viewer can see, so its
    works page mints a cursor for a different contributor resource."""
    for media_id, title in (
        (_OTHER_AUTHOR_WORK_FIRST, "orchard ledger"),
        (_OTHER_AUTHOR_WORK_SECOND, "quarry ledger"),
    ):
        _credit_work(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            title=title,
            published_date="2018",
            author_name=_OTHER_AUTHOR_NAME,
        )
    return _contributor_handle(db, _OTHER_AUTHOR_NAME)


def _seed_default_library_entries(db: Session, *, viewer_id: UUID) -> None:
    """Six Media filed in the viewer's Default Library: three with no publication
    date (so a NULL-unsafe keyset equality strands the missing bucket), two
    sharing a title, and two sharing the membership instant Default orders by."""
    for media_id, title, published_date, created_at in (
        (_ENTRY_ALMANAC, "almanac of rivers", "2019-04-02", datetime(2026, 2, 5, tzinfo=UTC)),
        (_ENTRY_BULLETIN, "bulletin of tides", None, datetime(2026, 2, 4, tzinfo=UTC)),
        (_ENTRY_CANTO_DATED, "canto", "2019-04-02", datetime(2026, 2, 3, tzinfo=UTC)),
        (_ENTRY_CANTO_UNDATED, "canto", None, datetime(2026, 2, 3, tzinfo=UTC)),
        (_ENTRY_MOTIF, "mötley motif", "1996", datetime(2026, 2, 2, tzinfo=UTC)),
        (_ENTRY_ZODIAC, "zodiac primer", None, datetime(2026, 2, 1, tzinfo=UTC)),
    ):
        _file_media(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            title=title,
            published_date=published_date,
            created_at=created_at,
        )
    db.flush()


type _RowKey = Callable[[Mapping[str, Any]], str]


def _row_id(item: Mapping[str, Any]) -> str:
    """Identity of an index row that carries a top-level ``id``."""
    return str(item["id"])


def _work_href(item: Mapping[str, Any]) -> str:
    """Identity of an author-works row. ``ContributorWorkItemOut`` has no ``id``:
    the outward ``href`` is both the row's identity and the works plan's final
    key, because a work may be Media, a Podcast, or a Gutenberg catalog entry."""
    return str(item["href"])


def _entry_target(item: Mapping[str, Any]) -> str:
    """Identity of a Library entry row: its heterogeneous Media/Podcast target,
    which is what the entry plans page by."""
    return str(item[item["kind"]]["id"])


def _page_keys(
    client: TestClient, path: str, view: Mapping[str, str], *, key: _RowKey = _row_id
) -> list[str]:
    """Row keys of one unpaged request for ``view``."""
    response = client.get(path, params=dict(view))
    assert response.status_code == 200, f"GET {path} {dict(view)} failed: {response.text}"
    return [key(item) for item in response.json()["data"]["items"]]


def _drained_keys(
    client: TestClient, path: str, view: Mapping[str, str], *, key: _RowKey = _row_id
) -> list[str]:
    """Row keys of ``view`` drained one row per page through its own cursors."""
    keys: list[str] = []
    params = {**view, "limit": "1"}
    for _ in range(_MAX_DRAINED_PAGES):
        response = client.get(path, params=params)
        assert response.status_code == 200, f"GET {path} {params} failed: {response.text}"
        page = response.json()["data"]
        keys.extend(key(item) for item in page["items"])
        cursor = page["nextCursor"]
        if cursor["kind"] == "Absent":
            return keys
        params = {
            **view,
            "limit": "1",
            "cursor": cursor["value"],
            "collection_revision": str(page["collectionRevision"]),
        }
    raise AssertionError(
        f"GET {path} {dict(view)} never exhausted its cursor within {_MAX_DRAINED_PAGES}"
        f" single-row pages; drained {keys}"
    )


def _tampered(cursor: str) -> str:
    return ("A" if cursor[0] != "A" else "B") + cursor[1:]


def _first_cursor(client: TestClient, path: str, view: Mapping[str, str]) -> str:
    response = client.get(path, params={**view, "limit": "1"})
    assert response.status_code == 200, f"GET {path} {dict(view)} failed: {response.text}"
    cursor = response.json()["data"]["nextCursor"]
    assert cursor["kind"] == "Present", (
        f"GET {path} {dict(view)} at limit=1 yielded no cursor to replay: {response.text}"
    )
    return cursor["value"]


def _assert_refuses_cursor(
    client: TestClient, path: str, cases: Mapping[str, dict[str, str]]
) -> None:
    for case, params in cases.items():
        response = client.get(path, params={"limit": "1", **params})
        assert response.status_code == 400, (
            f"GET {path} accepted a {case}: {response.status_code} {response.text}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR", (
            f"GET {path} refused a {case} with the wrong code: {response.text}"
        )


def test_every_advertised_author_works_view_is_the_exact_total_order_its_cursor_pages(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    handle = _seed_author_works(db_session, viewer_id=test_user.id)
    path = f"/contributors/{handle}/works"
    # `date_missing` never reverses, so the three undated works stay last in both
    # publication directions and keep title/href order there. A shared `date_key`
    # is broken by title ASC; a shared title is broken by `date_missing`, then
    # `date_key DESC`, then href — which is the only key separating the two
    # undated `delta echo` works under either title direction.
    advertised: dict[str, tuple[dict[str, str], list[UUID]]] = {
        "Published — newest": (
            {},
            [
                _WORK_ATLAS,
                _WORK_FACADE,
                _WORK_BEACON,
                _WORK_CAIRN,
                _WORK_DELTA_FIRST,
                _WORK_DELTA_SECOND,
                _WORK_ZEPHYR,
            ],
        ),
        "Published — oldest": (
            {"sort": "published", "direction": "asc"},
            [
                _WORK_CAIRN,
                _WORK_BEACON,
                _WORK_ATLAS,
                _WORK_FACADE,
                _WORK_DELTA_FIRST,
                _WORK_DELTA_SECOND,
                _WORK_ZEPHYR,
            ],
        ),
        "Title — A–Z": (
            {"sort": "title", "direction": "asc"},
            [
                _WORK_ATLAS,
                _WORK_BEACON,
                _WORK_CAIRN,
                _WORK_DELTA_FIRST,
                _WORK_DELTA_SECOND,
                _WORK_FACADE,
                _WORK_ZEPHYR,
            ],
        ),
        "Title — Z–A": (
            {"sort": "title", "direction": "desc"},
            [
                _WORK_ZEPHYR,
                _WORK_FACADE,
                _WORK_DELTA_FIRST,
                _WORK_DELTA_SECOND,
                _WORK_CAIRN,
                _WORK_BEACON,
                _WORK_ATLAS,
            ],
        ),
    }

    for label, (view, order) in advertised.items():
        expected = [f"/media/{media_id}" for media_id in order]
        assert _page_keys(authenticated_client, path, view, key=_work_href) == expected, (
            f"author works view {label!r} ({view}) on {path} is not the specified total order;"
            f" expected {expected}, got"
            f" {_page_keys(authenticated_client, path, view, key=_work_href)}"
        )
        assert _drained_keys(authenticated_client, path, view, key=_work_href) == expected, (
            f"author works view {label!r} ({view}) on {path} drained one row per page does not"
            " equal its unpaged snapshot; a work was duplicated or skipped across the keyset"
        )


def test_every_advertised_chat_index_view_is_the_exact_total_order_its_cursor_pages(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _seed_chats(db_session, viewer_id=test_user.id)
    # `updated` reverses both its keys; `title` keeps `updated_at DESC, id DESC`
    # in both directions, so the duplicate-title pair holds its order either way.
    advertised: dict[str, tuple[dict[str, str], list[UUID]]] = {
        "Updated — newest": (
            {},
            [
                _CHAT_ALPHA,
                _CHAT_CAFE,
                _CHAT_NAIVE,
                _CHAT_ZULU,
                _CHAT_SHARED_NEWER,
                _CHAT_SHARED_OLDER,
            ],
        ),
        "Updated — oldest": (
            {"sort": "updated", "direction": "asc"},
            [
                _CHAT_SHARED_OLDER,
                _CHAT_SHARED_NEWER,
                _CHAT_ZULU,
                _CHAT_NAIVE,
                _CHAT_CAFE,
                _CHAT_ALPHA,
            ],
        ),
        "Title — A–Z": (
            {"sort": "title", "direction": "asc"},
            [
                _CHAT_ALPHA,
                _CHAT_CAFE,
                _CHAT_NAIVE,
                _CHAT_SHARED_NEWER,
                _CHAT_SHARED_OLDER,
                _CHAT_ZULU,
            ],
        ),
        "Title — Z–A": (
            {"sort": "title", "direction": "desc"},
            [
                _CHAT_ZULU,
                _CHAT_SHARED_NEWER,
                _CHAT_SHARED_OLDER,
                _CHAT_NAIVE,
                _CHAT_CAFE,
                _CHAT_ALPHA,
            ],
        ),
    }

    for label, (view, order) in advertised.items():
        expected = [str(chat_id) for chat_id in order]
        assert _page_keys(authenticated_client, "/conversations", view) == expected, (
            f"chat index view {label!r} ({view}) is not the specified total order;"
            f" expected {expected}, got {_page_keys(authenticated_client, '/conversations', view)}"
        )
        assert _drained_keys(authenticated_client, "/conversations", view) == expected, (
            f"chat index view {label!r} ({view}) drained one row per page does not equal its"
            " unpaged snapshot; a row was duplicated or skipped across the keyset"
        )


def test_every_advertised_libraries_index_view_is_the_exact_total_order_its_cursor_pages(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _seed_libraries(db_session, viewer_id=test_user.id)
    default_library = str(test_user.default_library_id)
    # The Default Library is stored as "My Library" and presented as "All", so a
    # name order keyed on the stored name would place it between "delta" and
    # "zürich" instead of first. `created` reverses both its keys; `name` keeps
    # `id ASC` in both directions.
    advertised: dict[str, tuple[dict[str, str], list[str]]] = {
        "Created — oldest": (
            {},
            [
                str(_LIBRARY_DELTA_FIRST),
                str(_LIBRARY_DELTA_SECOND),
                str(_LIBRARY_BETA),
                str(_LIBRARY_ZURICH),
                default_library,
            ],
        ),
        "Created — newest": (
            {"sort": "created", "direction": "desc"},
            [
                default_library,
                str(_LIBRARY_ZURICH),
                str(_LIBRARY_BETA),
                str(_LIBRARY_DELTA_SECOND),
                str(_LIBRARY_DELTA_FIRST),
            ],
        ),
        "Name — A–Z": (
            {"sort": "name", "direction": "asc"},
            [
                default_library,
                str(_LIBRARY_BETA),
                str(_LIBRARY_DELTA_FIRST),
                str(_LIBRARY_DELTA_SECOND),
                str(_LIBRARY_ZURICH),
            ],
        ),
        "Name — Z–A": (
            {"sort": "name", "direction": "desc"},
            [
                str(_LIBRARY_ZURICH),
                str(_LIBRARY_DELTA_FIRST),
                str(_LIBRARY_DELTA_SECOND),
                str(_LIBRARY_BETA),
                default_library,
            ],
        ),
    }

    for label, (view, expected) in advertised.items():
        assert _page_keys(authenticated_client, "/libraries", view) == expected, (
            f"Libraries index view {label!r} ({view}) is not the specified total order;"
            f" expected {expected}, got {_page_keys(authenticated_client, '/libraries', view)}"
        )
        assert _drained_keys(authenticated_client, "/libraries", view) == expected, (
            f"Libraries index view {label!r} ({view}) drained one row per page does not equal"
            " its unpaged snapshot; a row was duplicated or skipped across the keyset"
        )


def test_every_advertised_notes_index_view_orders_the_exhaustive_page(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _seed_pages(db_session, viewer_id=test_user.id)
    # `updated` reverses only its own key: title stays ASC, so the two Pages
    # sharing an instant keep title order in both directions.
    advertised: dict[str, tuple[dict[str, str], list[UUID]]] = {
        "Updated — newest": (
            {},
            [_PAGE_ALPHA, _PAGE_CAFE, _PAGE_SHARED_NEWER, _PAGE_ZULU, _PAGE_SHARED_OLDER],
        ),
        "Updated — oldest": (
            {"sort": "updated", "direction": "asc"},
            [_PAGE_SHARED_OLDER, _PAGE_SHARED_NEWER, _PAGE_ZULU, _PAGE_CAFE, _PAGE_ALPHA],
        ),
        "Title — A–Z": (
            {"sort": "title", "direction": "asc"},
            [_PAGE_ALPHA, _PAGE_CAFE, _PAGE_SHARED_NEWER, _PAGE_SHARED_OLDER, _PAGE_ZULU],
        ),
        "Title — Z–A": (
            {"sort": "title", "direction": "desc"},
            [_PAGE_ZULU, _PAGE_SHARED_NEWER, _PAGE_SHARED_OLDER, _PAGE_CAFE, _PAGE_ALPHA],
        ),
    }

    for label, (view, order) in advertised.items():
        response = authenticated_client.get("/notes/pages", params=view)
        assert response.status_code == 200, f"GET /notes/pages {view} failed: {response.text}"
        served = [page["id"] for page in response.json()["data"]["pages"]]
        assert served == [str(page_id) for page_id in order], (
            f"Notes index view {label!r} ({view}) is not the specified total order;"
            f" expected {[str(page_id) for page_id in order]}, got {served}"
        )


def test_library_entry_views_drain_exactly_their_unpaged_snapshot_over_missing_and_tied_keys(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    """Library entries page through the same extracted `collection_keyset`
    mechanism as the indexes above. Its canonical order ties on the membership
    instant, its title order ties on the title key, and its publication order
    carries a missing-rank key over a nullable value key — the three shapes whose
    keyset predicate, ORDER BY, and cursor must agree for a drain to be lossless.
    """
    _seed_default_library_entries(db_session, viewer_id=test_user.id)
    path = f"/libraries/{test_user.default_library_id}/entries"
    seeded = {
        str(_ENTRY_ALMANAC),
        str(_ENTRY_BULLETIN),
        str(_ENTRY_CANTO_DATED),
        str(_ENTRY_CANTO_UNDATED),
        str(_ENTRY_MOTIF),
        str(_ENTRY_ZODIAC),
    }
    proved: dict[str, dict[str, str]] = {
        "Canonical — Default membership newest": {},
        "Title — A–Z": {"sort": "title", "direction": "asc"},
        "Published — newest": {"sort": "published", "direction": "desc"},
    }

    for label, view in proved.items():
        snapshot = _page_keys(authenticated_client, path, view, key=_entry_target)
        assert set(snapshot) == seeded and len(snapshot) == len(seeded), (
            f"Library entries view {label!r} ({view}) on {path} did not serve the seeded entry set"
            f" in one unpaged page; expected {sorted(seeded)}, got {snapshot}"
        )
        assert _drained_keys(authenticated_client, path, view, key=_entry_target) == snapshot, (
            f"Library entries view {label!r} ({view}) on {path} drained one row per page does not"
            " equal its unpaged snapshot; a target was duplicated or skipped across the keyset"
        )


def test_author_works_cursor_is_refused_outside_the_binding_that_minted_it(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    handle = _seed_author_works(db_session, viewer_id=test_user.id)
    other_handle = _seed_second_author_works(db_session, viewer_id=test_user.id)
    stranger_id = uuid4()
    ensure_user_and_default_library(
        db_session, stranger_id, f"cursor-proof-{stranger_id}@example.invalid"
    )
    # Filing bumps AuthorWorks for every viewer, so every seed — including the
    # stranger's — must complete before this viewer's revision is read.
    stranger_cursor = _stranger_works_cursor(
        db_session, stranger_id=stranger_id, contributor_handle=handle
    )

    path = f"/contributors/{handle}/works"
    first = authenticated_client.get(path, params={"limit": "1"})
    assert first.status_code == 200, f"GET {path} failed: {first.text}"
    revision = str(first.json()["data"]["collectionRevision"])
    canonical_cursor = _first_cursor(authenticated_client, path, {})

    _assert_refuses_cursor(
        authenticated_client,
        path,
        {
            "tampered cursor payload": {
                "cursor": _tampered(canonical_cursor),
                "collection_revision": revision,
            },
            # The exact retired wire shape: an unversioned family whose query
            # named no order plan and no revision.
            "cursor of the retired unversioned family": {
                "cursor": encode_signed_keyset_cursor(
                    family=CollectionFamily.AuthorWorks.value,
                    query={"contributorHandle": str(handle), "viewerId": str(test_user.id)},
                    after=(
                        KeysetValue(KeysetValueKind.Int, 0),
                        KeysetValue(KeysetValueKind.TextOrNull, "2001-03-04"),
                        KeysetValue(KeysetValueKind.Text, "atlas of tides"),
                        KeysetValue(KeysetValueKind.Text, f"/media/{_WORK_ATLAS}"),
                    ),
                ),
                "collection_revision": revision,
            },
            "cursor minted under the Title — A–Z view": {
                "cursor": _first_cursor(
                    authenticated_client, path, {"sort": "title", "direction": "asc"}
                ),
                "collection_revision": revision,
            },
            "cursor minted for a different contributor": {
                "cursor": _first_cursor(
                    authenticated_client, f"/contributors/{other_handle}/works", {}
                ),
                "collection_revision": revision,
            },
            "cursor minted for a different viewer": {
                "cursor": stranger_cursor,
                "collection_revision": revision,
            },
        },
    )

    _credit_work(
        db_session,
        viewer_id=test_user.id,
        media_id=_WORK_REVISION_BUMP,
        title="quill addendum",
        published_date="2010",
        author_name=_AUTHOR_NAME,
    )
    bumped = authenticated_client.get(path, params={"limit": "1"})
    bumped_revision = str(bumped.json()["data"]["collectionRevision"])
    assert bumped_revision != revision, (
        f"crediting another work left the author works revision for {handle} at {revision}"
    )
    _assert_refuses_cursor(
        authenticated_client,
        path,
        {
            "cursor minted before the collection revision changed": {
                "cursor": canonical_cursor,
                "collection_revision": bumped_revision,
            }
        },
    )


def test_conversation_index_cursor_is_refused_outside_the_binding_that_minted_it(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _seed_chats(db_session, viewer_id=test_user.id)
    first = authenticated_client.get("/conversations", params={"limit": "1"})
    assert first.status_code == 200, f"GET /conversations failed: {first.text}"
    revision = str(first.json()["data"]["collectionRevision"])
    canonical_cursor = _first_cursor(authenticated_client, "/conversations", {})

    stranger_id = uuid4()
    ensure_user_and_default_library(
        db_session, stranger_id, f"cursor-proof-{stranger_id}@example.invalid"
    )

    _assert_refuses_cursor(
        authenticated_client,
        "/conversations",
        {
            "tampered cursor payload": {
                "cursor": _tampered(canonical_cursor),
                "collection_revision": revision,
            },
            # The exact retired wire shape: an unversioned family whose query
            # named no order plan and no revision.
            "cursor of the retired unversioned family": {
                "cursor": encode_signed_keyset_cursor(
                    family=CollectionFamily.ConversationIndex.value,
                    query={"scope": "mine", "viewerId": str(test_user.id)},
                    after=(
                        KeysetValue(KeysetValueKind.DateTime, datetime(2026, 1, 5, tzinfo=UTC)),
                        KeysetValue(KeysetValueKind.Uuid, _CHAT_ALPHA),
                    ),
                ),
                "collection_revision": revision,
            },
            "cursor minted under the Title — A–Z view": {
                "cursor": _first_cursor(
                    authenticated_client,
                    "/conversations",
                    {"sort": "title", "direction": "asc"},
                ),
                "collection_revision": revision,
            },
            "cursor minted under scope=all": {
                "cursor": _first_cursor(authenticated_client, "/conversations", {"scope": "all"}),
                "collection_revision": revision,
                "scope": "shared",
            },
            "cursor minted for a different viewer": {
                "cursor": _stranger_conversation_cursor(db_session, stranger_id=stranger_id),
                "collection_revision": revision,
            },
        },
    )

    conversations_service.create_conversation(db_session, test_user.id)
    bumped = authenticated_client.get("/conversations", params={"limit": "1"})
    bumped_revision = str(bumped.json()["data"]["collectionRevision"])
    assert bumped_revision != revision, (
        f"creating a chat left the conversation index revision at {revision}"
    )
    _assert_refuses_cursor(
        authenticated_client,
        "/conversations",
        {
            "cursor minted before the collection revision changed": {
                "cursor": canonical_cursor,
                "collection_revision": bumped_revision,
            }
        },
    )


def test_libraries_index_cursor_is_refused_outside_the_binding_that_minted_it(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _seed_libraries(db_session, viewer_id=test_user.id)
    first = authenticated_client.get("/libraries", params={"limit": "1"})
    assert first.status_code == 200, f"GET /libraries failed: {first.text}"
    revision = str(first.json()["data"]["collectionRevision"])
    canonical_cursor = _first_cursor(authenticated_client, "/libraries", {})

    stranger_id = uuid4()
    ensure_user_and_default_library(
        db_session, stranger_id, f"cursor-proof-{stranger_id}@example.invalid"
    )

    _assert_refuses_cursor(
        authenticated_client,
        "/libraries",
        {
            "tampered cursor payload": {
                "cursor": _tampered(canonical_cursor),
                "collection_revision": revision,
            },
            "cursor of the retired unversioned family": {
                "cursor": encode_signed_keyset_cursor(
                    family=CollectionFamily.LibrariesIndex.value,
                    query={"viewerId": str(test_user.id)},
                    after=(
                        KeysetValue(KeysetValueKind.DateTime, datetime(2026, 1, 1, tzinfo=UTC)),
                        KeysetValue(KeysetValueKind.Uuid, _LIBRARY_DELTA_FIRST),
                    ),
                ),
                "collection_revision": revision,
            },
            "cursor minted under the Name — A–Z view": {
                "cursor": _first_cursor(
                    authenticated_client, "/libraries", {"sort": "name", "direction": "asc"}
                ),
                "collection_revision": revision,
            },
            "cursor minted for a different viewer": {
                "cursor": _stranger_libraries_cursor(db_session, stranger_id=stranger_id),
                "collection_revision": revision,
            },
        },
    )

    library_governance.create_library(
        db_session,
        test_user.id,
        CreateLibraryRequest(library_id=uuid4(), name="revision bump shelf"),
    )
    bumped = authenticated_client.get("/libraries", params={"limit": "1"})
    bumped_revision = str(bumped.json()["data"]["collectionRevision"])
    assert bumped_revision != revision, (
        f"creating a Library left the Libraries index revision at {revision}"
    )
    _assert_refuses_cursor(
        authenticated_client,
        "/libraries",
        {
            "cursor minted before the collection revision changed": {
                "cursor": canonical_cursor,
                "collection_revision": bumped_revision,
            }
        },
    )


def _stranger_works_cursor(
    db: Session, *, stranger_id: UUID, contributor_handle: ContributorHandle
) -> str:
    """A canonical cursor the works owner minted for another viewer over the SAME
    author, so only the bound viewer differs from the replaying request."""
    for media_id, title in (
        (_STRANGER_WORK_FIRST, "stranger anthem"),
        (_STRANGER_WORK_SECOND, "stranger bulletin"),
    ):
        _credit_work(
            db,
            viewer_id=stranger_id,
            media_id=media_id,
            title=title,
            published_date="2020",
            author_name=_AUTHOR_NAME,
        )
    page = contributors_service.list_contributor_works(
        db,
        viewer_id=stranger_id,
        contributor_handle=contributor_handle,
        view=contributors_service.WorksPublishedNewest(),
        limit=1,
    )
    assert page.next_cursor.kind == "Present", (
        f"stranger {stranger_id} yielded no author works cursor to replay: {page!r}"
    )
    return page.next_cursor.value


def _stranger_conversation_cursor(db: Session, *, stranger_id: UUID) -> str:
    """A canonical cursor the index owner minted for another viewer's own chats."""
    for _ in range(2):
        db.add(Conversation(id=uuid4(), owner_user_id=stranger_id, title="stranger chat"))
    db.flush()
    page = conversations_service.list_conversation_index(
        db,
        viewer_id=stranger_id,
        limit=1,
        cursor=None,
        collection_revision=None,
        scope=None,
        view=conversations_service.ChatsUpdatedNewest(),
    )
    assert page.next_cursor.kind == "Present", (
        f"stranger {stranger_id} yielded no conversation cursor to replay: {page!r}"
    )
    return page.next_cursor.value


def _stranger_libraries_cursor(db: Session, *, stranger_id: UUID) -> str:
    library_governance.create_library(
        db,
        stranger_id,
        CreateLibraryRequest(library_id=uuid4(), name="stranger shelf"),
    )
    page = library_governance.list_libraries(
        db,
        stranger_id,
        view=library_governance.LibrariesCreatedOldest(),
        limit=1,
    )
    assert page.next_cursor.kind == "Present", (
        f"stranger {stranger_id} yielded no Libraries cursor to replay: {page!r}"
    )
    return page.next_cursor.value


@pytest.mark.parametrize(
    ("path", "query"),
    [
        # The works route parses its query before it resolves the author, so an
        # unseeded but grammatical handle is enough to observe the refusal.
        pytest.param(
            "/contributors/unseeded-author/works",
            "sort=published&direction=desc",
            id="author-works-explicit-default",
        ),
        pytest.param(
            "/contributors/unseeded-author/works",
            "sort=title",
            id="author-works-sort-without-direction",
        ),
        pytest.param(
            "/contributors/unseeded-author/works",
            "direction=asc",
            id="author-works-direction-without-sort",
        ),
        pytest.param(
            "/contributors/unseeded-author/works",
            "sort=added&direction=asc",
            id="author-works-unsupported-sort-key",
        ),
        pytest.param(
            "/contributors/unseeded-author/works",
            "sort=title&direction=up",
            id="author-works-unknown-direction",
        ),
        pytest.param(
            "/contributors/unseeded-author/works",
            "sort=title&direction=asc&direction=desc",
            id="author-works-duplicate-direction-key",
        ),
        pytest.param("/conversations", "sort=updated&direction=desc", id="chats-explicit-default"),
        pytest.param("/conversations", "sort=title", id="chats-sort-without-direction"),
        pytest.param("/conversations", "sort=added&direction=asc", id="chats-unsupported-sort-key"),
        pytest.param(
            "/conversations",
            "q=draft&sort=title&direction=asc",
            id="chats-view-keys-in-the-destination-picker-mode",
        ),
        pytest.param(
            "/conversations",
            "has_context_ref=media:1&sort=title&direction=asc",
            id="chats-view-keys-in-the-context-ref-mode",
        ),
        pytest.param("/libraries", "sort=created&direction=asc", id="libraries-explicit-default"),
        pytest.param("/libraries", "direction=desc", id="libraries-direction-without-sort"),
        pytest.param("/libraries", "sort=name&direction=up", id="libraries-unknown-direction"),
        pytest.param("/notes/pages", "sort=updated&direction=desc", id="notes-explicit-default"),
        pytest.param("/notes/pages", "sort=title", id="notes-sort-without-direction"),
        pytest.param("/notes/pages", "limit=10", id="notes-page-key-it-has-no-contract-for"),
        pytest.param(
            "/notes/pages",
            "sort=title&direction=asc&direction=desc",
            id="notes-duplicate-direction-key",
        ),
    ],
)
def test_index_view_state_outside_the_advertised_inventory_is_refused_by_its_endpoint(
    authenticated_client: TestClient,
    path: str,
    query: str,
) -> None:
    response = authenticated_client.get(f"{path}?{query}")
    assert response.status_code == 400, (
        f"GET {path}?{query} returned {response.status_code}, not a refusal: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST", (
        f"GET {path}?{query} was refused with the wrong code: {response.text}"
    )
