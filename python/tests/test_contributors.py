"""HTTP route surface for the lightweight author-deduplication cutover.

Service-level resolver/replacement/replay behaviour lives in
``test_author_deduplication_cutover.py`` and ``test_author_races.py``; this file
exercises the final FastAPI surface end to end through ``auth_client``:

    GET   /contributors?q=...&cursor=...&limit=...
    GET   /contributors/{handle}
    GET   /contributors/{handle}/works?cursor=...&limit=...
    PATCH /contributors/{handle}
    PUT   /media/{media_id}/authors

Contributors are seeded the way the product creates them — through the manual
media-author PUT — so these tests double as coverage of the create/bind path.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.factories import add_media_to_library, create_test_media, create_test_media_in_library
from tests.helpers import auth_headers, create_test_user_id

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _bootstrap_user(auth_client, direct_db, *, roles=None):
    """Create + register a fresh user and return (user_id, default_library_id)."""
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    headers = auth_headers(user_id, nexus_roles=roles) if roles else auth_headers(user_id)
    me = auth_client.get("/me", headers=headers)
    assert me.status_code == 200, me.text
    return user_id, UUID(me.json()["data"]["default_library_id"])


def _new_author_row(credited_name, display_name=None):
    return {
        "creditedName": credited_name,
        "binding": {"kind": "new", "displayName": display_name or credited_name},
    }


def _existing_author_row(credited_name, handle):
    return {
        "creditedName": credited_name,
        "binding": {"kind": "existing", "contributorHandle": handle},
    }


def _put_authors(auth_client, user_id, media_id, rows, *, mode="manual", client_mutation_id=None):
    body = {"clientMutationId": client_mutation_id or f"cmid-{uuid4()}", "mode": mode}
    if mode == "manual":
        body["authors"] = rows
    return auth_client.put(
        f"/media/{media_id}/authors",
        headers=auth_headers(user_id),
        json=body,
    )


def _register_media_credit_cleanup(direct_db, media_id):
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)


def _contributor_id_for_handle(direct_db, handle):
    with direct_db.session() as session:
        contributor_id = session.execute(
            text("SELECT id FROM contributors WHERE handle = :handle"),
            {"handle": handle},
        ).scalar_one()
    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
    # Cleanup runs LIFO: credits must delete before the contributor row they
    # reference (media-scoped credit cleanups registered earlier run last).
    direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)
    return contributor_id


def _seed_owned_media(direct_db, owner_id, library_id, *, title=None):
    with direct_db.session() as session:
        media_id = create_test_media_in_library(
            session, owner_id, library_id, title=title or f"Authored Work {uuid4()}"
        )
        session.commit()
    _register_media_credit_cleanup(direct_db, media_id)
    return media_id


def _seed_author(auth_client, direct_db, owner_id, library_id, *, credited_name, display_name=None):
    """Create an owned media with one ``new`` author; return (media_id, handle)."""
    media_id = _seed_owned_media(direct_db, owner_id, library_id, title=f"{credited_name} Work")
    response = _put_authors(
        auth_client, owner_id, media_id, [_new_author_row(credited_name, display_name)]
    )
    assert response.status_code == 200, response.text
    handle = response.json()["data"]["authors"][0]["contributorHandle"]
    _contributor_id_for_handle(direct_db, handle)
    return media_id, handle


# ---------------------------------------------------------------------------
# GET /contributors — required nonblank q
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.parametrize("query", ["", "%20%20", "+"])
def test_search_contributors_rejects_blank_query_with_422(auth_client, direct_db, query):
    viewer_id, _ = _bootstrap_user(auth_client, direct_db)
    response = auth_client.get(f"/contributors?q={query}", headers=auth_headers(viewer_id))
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


# ---------------------------------------------------------------------------
# Handle parsing: reserved + invisible + garbage all 404
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.parametrize(
    "handle",
    ["directory", "reconciliation-candidates", "a", "Not-A-Handle", "-leading", "trailing-"],
)
def test_reserved_or_invalid_handles_return_404(auth_client, direct_db, handle):
    viewer_id, _ = _bootstrap_user(auth_client, direct_db)
    detail = auth_client.get(f"/contributors/{handle}", headers=auth_headers(viewer_id))
    works = auth_client.get(f"/contributors/{handle}/works", headers=auth_headers(viewer_id))
    assert detail.status_code == 404, detail.text
    assert works.status_code == 404, works.text
    assert detail.json()["error"]["code"] == "E_NOT_FOUND"


@pytest.mark.integration
def test_contributor_detail_masks_invisible_records(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    outsider_id, _ = _bootstrap_user(auth_client, direct_db)
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Hidden Author {uuid4()}"
    )

    owner_view = auth_client.get(f"/contributors/{handle}", headers=auth_headers(owner_id))
    outsider_view = auth_client.get(f"/contributors/{handle}", headers=auth_headers(outsider_id))

    assert owner_view.status_code == 200, owner_view.text
    assert outsider_view.status_code == 404, outsider_view.text


# ---------------------------------------------------------------------------
# Removed-endpoint matrix (AC 30): the old surface is gone
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/contributors/directory"),
        ("GET", "/contributors/reconciliation-candidates"),
        ("POST", "/contributors/reconciliation-candidates/x/accept"),
        ("POST", "/contributors/reconciliation-candidates/x/reject"),
        ("POST", "/contributors/some-author/merge"),
        ("POST", "/contributors/some-author/split"),
        ("POST", "/contributors/some-author/tombstone"),
        ("POST", "/contributors/some-author/aliases"),
        ("DELETE", "/contributors/some-author/aliases/x"),
        ("POST", "/contributors/some-author/external-ids"),
        ("DELETE", "/contributors/some-author/external-ids/x"),
    ],
)
def test_removed_contributor_endpoints_are_gone(auth_client, direct_db, method, path):
    viewer_id, _ = _bootstrap_user(auth_client, direct_db)
    response = auth_client.request(method, path, headers=auth_headers(viewer_id))
    assert response.status_code in (404, 405), f"{method} {path} -> {response.status_code}"


# ---------------------------------------------------------------------------
# Strict camelCase both directions (D-1): snake payloads are rejected
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_put_media_authors_rejects_snake_payload(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    response = auth_client.put(
        f"/media/{media_id}/authors",
        headers=auth_headers(owner_id),
        json={
            "client_mutation_id": f"cmid-{uuid4()}",
            "mode": "manual",
            "authors": [
                {"credited_name": "Snake Author", "binding": {"kind": "new", "display_name": "x"}}
            ],
        },
    )
    assert response.status_code == 422, response.text


@pytest.mark.integration
def test_rename_rejects_snake_payload(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Snake Rename {uuid4()}"
    )
    response = auth_client.patch(
        f"/contributors/{handle}",
        headers=auth_headers(owner_id, nexus_roles=["contributor_curator"]),
        json={"client_mutation_id": f"cmid-{uuid4()}", "display_name": "New Name"},
    )
    assert response.status_code == 422, response.text


@pytest.mark.integration
@pytest.mark.parametrize(
    "row",
    [
        # Whitespace-only creditedName would clean to empty (a 500 without the
        # boundary validator); whitespace-only new displayName would persist an
        # empty-display contributor.
        {"creditedName": "   ", "binding": {"kind": "new", "displayName": "Valid Name"}},
        {"creditedName": "Valid Name", "binding": {"kind": "new", "displayName": " 　 "}},
    ],
)
def test_put_media_authors_rejects_blank_names_with_422(auth_client, direct_db, row):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    response = _put_authors(auth_client, owner_id, media_id, [row])
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


@pytest.mark.integration
def test_rename_rejects_blank_display_name_with_422(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Blank Rename {uuid4()}"
    )
    response = auth_client.patch(
        f"/contributors/{handle}",
        headers=auth_headers(owner_id, nexus_roles=["contributor_curator"]),
        json={"clientMutationId": f"cmid-{uuid4()}", "displayName": "   "},
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


# ---------------------------------------------------------------------------
# PUT matrix
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_put_media_authors_manual_preserves_order(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    response = _put_authors(
        auth_client,
        owner_id,
        media_id,
        [_new_author_row("First Author"), _new_author_row("Second Author")],
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["authorMode"] == "manual"
    assert [row["creditedName"] for row in data["authors"]] == ["First Author", "Second Author"]
    for row in data["authors"]:
        _contributor_id_for_handle(direct_db, row["contributorHandle"])


@pytest.mark.integration
def test_put_media_authors_accepts_empty_manual_slice(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Erasable {uuid4()}"
    )
    assert handle
    cleared = _put_authors(auth_client, owner_id, media_id, [])
    assert cleared.status_code == 200, cleared.text
    body = cleared.json()["data"]
    assert body["authors"] == []
    assert body["authorMode"] == "manual"


@pytest.mark.integration
def test_put_media_authors_rejects_duplicate_contributor(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Dupe Source {uuid4()}"
    )
    response = _put_authors(
        auth_client,
        owner_id,
        media_id,
        [_existing_author_row("Once", handle), _existing_author_row("Twice", handle)],
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_AUTHOR_ALREADY_LISTED"


@pytest.mark.integration
def test_put_media_authors_rejects_unknown_handle(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    response = _put_authors(
        auth_client,
        owner_id,
        media_id,
        [_existing_author_row("Ghost", "no-such-author-abcdef123456")],
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_AUTHOR_NOT_SELECTABLE"


@pytest.mark.integration
def test_put_media_authors_rejects_invisible_handle_without_leaking(auth_client, direct_db):
    # A contributor credited only on another user's private media is invisible;
    # binding to it is E_AUTHOR_NOT_SELECTABLE, indistinguishable from unknown.
    other_id, other_library = _bootstrap_user(auth_client, direct_db)
    _other_media, hidden_handle = _seed_author(
        auth_client, direct_db, other_id, other_library, credited_name=f"Private Only {uuid4()}"
    )
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    response = _put_authors(
        auth_client, owner_id, media_id, [_existing_author_row("Hidden", hidden_handle)]
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "E_AUTHOR_NOT_SELECTABLE"


@pytest.mark.integration
def test_put_media_authors_automatic_reset_rejects_authors_field(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id, _handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Reset Me {uuid4()}"
    )
    rejected = auth_client.put(
        f"/media/{media_id}/authors",
        headers=auth_headers(owner_id),
        json={"clientMutationId": f"cmid-{uuid4()}", "mode": "automatic", "authors": []},
    )
    assert rejected.status_code == 422, rejected.text

    reset = _put_authors(auth_client, owner_id, media_id, [], mode="automatic")
    assert reset.status_code == 200, reset.text
    assert reset.json()["data"]["authorMode"] == "automatic"


@pytest.mark.integration
def test_put_media_authors_capability_parity_creator_and_reader(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    reader_id, reader_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    with direct_db.session() as session:
        add_media_to_library(session, reader_library, media_id)
        session.commit()

    owner_media = auth_client.get(f"/media/{media_id}", headers=auth_headers(owner_id))
    reader_media = auth_client.get(f"/media/{media_id}", headers=auth_headers(reader_id))
    assert owner_media.status_code == 200, owner_media.text
    assert reader_media.status_code == 200, reader_media.text
    assert owner_media.json()["data"]["capabilities"]["can_edit_authors"] is True
    assert reader_media.json()["data"]["capabilities"]["can_edit_authors"] is False

    owner_put = _put_authors(auth_client, owner_id, media_id, [_new_author_row("Owner Author")])
    reader_put = _put_authors(auth_client, reader_id, media_id, [_new_author_row("Reader Author")])
    assert owner_put.status_code == 200, owner_put.text
    assert reader_put.status_code == 403, reader_put.text
    for row in owner_put.json()["data"]["authors"]:
        _contributor_id_for_handle(direct_db, row["contributorHandle"])


@pytest.mark.integration
def test_put_media_authors_capability_parity_for_unready_media(auth_client, direct_db):
    """Author editing must not depend on content readability (spec §6): a creator's
    failed-ingest media reports can_edit_authors=True AND the PUT succeeds."""
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        media_id = create_test_media_in_library(
            session, owner_id, owner_library, title=f"Failed Ingest {uuid4()}", status="failed"
        )
    _register_media_credit_cleanup(direct_db, media_id)

    media = auth_client.get(f"/media/{media_id}", headers=auth_headers(owner_id))
    assert media.status_code == 200, media.text
    capabilities = media.json()["data"]["capabilities"]
    assert capabilities["can_read"] is False, "content must not be readable while failed"
    assert capabilities["can_edit_authors"] is True, (
        "the DTO must agree with enforcement: the creator can edit authors of unready media"
    )

    put = _put_authors(auth_client, owner_id, media_id, [_new_author_row("Unready Author")])
    assert put.status_code == 200, put.text
    for row in put.json()["data"]["authors"]:
        _contributor_id_for_handle(direct_db, row["contributorHandle"])


@pytest.mark.integration
def test_null_creator_media_is_admin_only(auth_client, direct_db):
    admin_id, admin_library = _bootstrap_user(auth_client, direct_db, roles=["admin"])
    reader_id, reader_library = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        media_id = create_test_media(session, title=f"System Media {uuid4()}")
        add_media_to_library(session, admin_library, media_id)
        add_media_to_library(session, reader_library, media_id)
        session.commit()
    _register_media_credit_cleanup(direct_db, media_id)

    admin_media = auth_client.get(
        f"/media/{media_id}", headers=auth_headers(admin_id, nexus_roles=["admin"])
    )
    reader_media = auth_client.get(f"/media/{media_id}", headers=auth_headers(reader_id))
    assert admin_media.json()["data"]["capabilities"]["can_edit_authors"] is True
    assert reader_media.json()["data"]["capabilities"]["can_edit_authors"] is False

    admin_put = auth_client.put(
        f"/media/{media_id}/authors",
        headers=auth_headers(admin_id, nexus_roles=["admin"]),
        json={
            "clientMutationId": f"cmid-{uuid4()}",
            "mode": "manual",
            "authors": [_new_author_row("Admin Curated Author")],
        },
    )
    reader_put = _put_authors(auth_client, reader_id, media_id, [_new_author_row("Reader Author")])
    assert admin_put.status_code == 200, admin_put.text
    assert reader_put.status_code == 403, reader_put.text
    for row in admin_put.json()["data"]["authors"]:
        _contributor_id_for_handle(direct_db, row["contributorHandle"])


# ---------------------------------------------------------------------------
# Replay (idempotency) on the PUT
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_put_media_authors_replays_exact_memo_and_409s_on_mismatch(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    media_id = _seed_owned_media(direct_db, owner_id, owner_library)
    cmid = f"cmid-{uuid4()}"

    first = _put_authors(
        auth_client, owner_id, media_id, [_new_author_row("Replay Author")], client_mutation_id=cmid
    )
    assert first.status_code == 200, first.text
    handle = first.json()["data"]["authors"][0]["contributorHandle"]
    _contributor_id_for_handle(direct_db, handle)

    # Later edit with a different key changes the list.
    later = _put_authors(auth_client, owner_id, media_id, [_new_author_row("Later Author")])
    assert later.status_code == 200, later.text
    for row in later.json()["data"]["authors"]:
        _contributor_id_for_handle(direct_db, row["contributorHandle"])

    # Exact replay of the first key returns the recorded response without writing.
    replay = _put_authors(
        auth_client, owner_id, media_id, [_new_author_row("Replay Author")], client_mutation_id=cmid
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["data"] == first.json()["data"]

    # Same key, different payload -> 409.
    mismatch = _put_authors(
        auth_client, owner_id, media_id, [_new_author_row("Different")], client_mutation_id=cmid
    )
    assert mismatch.status_code == 409, mismatch.text
    assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"


# ---------------------------------------------------------------------------
# GET /contributors search + detail + works
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_search_returns_visible_author_with_work_context(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    name = f"Searchable Author {uuid4()}"
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=name
    )
    response = auth_client.get(
        f"/contributors?q={name.split()[0]}+Author", headers=auth_headers(owner_id)
    )
    assert response.status_code == 200, response.text
    items = response.json()["data"]["contributors"]
    match = next(item for item in items if item["handle"] == handle)
    assert match["href"] == f"/authors/{handle}"
    assert match["workCount"] >= 1
    assert len(match["workExamples"]) <= 2


@pytest.mark.integration
def test_zero_work_key_owner_is_absent_from_search(auth_client, direct_db):
    # A retained key owner with no visible credited work never becomes an eternal
    # "0 works" pick (spec 2.8 / D-8); the search predicate requires >=1 visible
    # credited target.
    viewer_id, _ = _bootstrap_user(auth_client, direct_db)
    name = f"Keyed No Works {uuid4()}"
    handle = f"keyed-no-works-{uuid4().hex[:12]}"
    contributor_id = uuid4()
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO contributors (id, handle, display_name)
                VALUES (:id, :handle, :display_name)
                """
            ),
            {"id": contributor_id, "handle": handle, "display_name": name},
        )
        session.execute(
            text(
                """
                INSERT INTO contributor_aliases
                    (id, contributor_id, alias, normalized_alias, resolves_identity)
                VALUES (:id, :contributor_id, :alias, :normalized, true)
                """
            ),
            {
                "id": uuid4(),
                "contributor_id": contributor_id,
                "alias": name,
                "normalized": name.lower(),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO contributor_external_ids
                    (id, contributor_id, authority, external_key)
                VALUES (:id, :contributor_id, 'orcid', :key)
                """
            ),
            {"id": uuid4(), "contributor_id": contributor_id, "key": f"0000-{uuid4().hex[:12]}"},
        )
        session.commit()
    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)

    response = auth_client.get(
        f"/contributors?q={name.split()[0]}+No+Works", headers=auth_headers(viewer_id)
    )
    assert response.status_code == 200, response.text
    handles = {item["handle"] for item in response.json()["data"]["contributors"]}
    assert handle not in handles


@pytest.mark.integration
def test_contributor_detail_reports_fresh_author(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Detail Author {uuid4()}"
    )
    response = auth_client.get(f"/contributors/{handle}", headers=auth_headers(owner_id))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["handle"] == handle
    assert data["href"] == f"/authors/{handle}"
    assert data["otherNames"] == []
    assert data["canRename"] is False


@pytest.mark.integration
def test_contributor_works_reports_role_facts(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    credited = f"Works Author {uuid4()}"
    media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=credited
    )
    response = auth_client.get(f"/contributors/{handle}/works", headers=auth_headers(owner_id))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["nextCursor"] is None
    assert len(data["works"]) == 1
    work = data["works"][0]
    assert work["href"] == f"/media/{media_id}"
    assert {"creditedName": credited, "role": "author", "rawRole": None} in work["roleFacts"]


@pytest.mark.integration
def test_contributor_works_pagination_uses_opaque_stable_cursor(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    credited = f"Prolific Author {uuid4()}"
    _first_media, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=credited
    )
    second_media = _seed_owned_media(direct_db, owner_id, owner_library)
    bound = _put_authors(
        auth_client, owner_id, second_media, [_existing_author_row(credited, handle)]
    )
    assert bound.status_code == 200, bound.text

    page1 = auth_client.get(f"/contributors/{handle}/works?limit=1", headers=auth_headers(owner_id))
    assert page1.status_code == 200, page1.text
    body1 = page1.json()["data"]
    assert len(body1["works"]) == 1
    cursor = body1["nextCursor"]
    assert isinstance(cursor, str) and cursor

    # Cursor is opaque (not a raw title/href) and stable across identical calls.
    repeat = auth_client.get(
        f"/contributors/{handle}/works?limit=1", headers=auth_headers(owner_id)
    )
    assert repeat.json()["data"]["nextCursor"] == cursor
    assert f"/media/{second_media}" not in cursor and f"/media/{_first_media}" not in cursor

    page2 = auth_client.get(
        f"/contributors/{handle}/works?limit=1&cursor={cursor}",
        headers=auth_headers(owner_id),
    )
    assert page2.status_code == 200, page2.text
    body2 = page2.json()["data"]
    assert len(body2["works"]) == 1
    assert body2["works"][0]["href"] != body1["works"][0]["href"]


# ---------------------------------------------------------------------------
# PATCH /contributors/{handle} — rename authorization + replay
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_rename_visible_but_unauthorized_returns_403(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Rename Guard {uuid4()}"
    )
    # The creator can see the contributor but is not a curator/admin -> 403 (not 404).
    response = auth_client.patch(
        f"/contributors/{handle}",
        headers=auth_headers(owner_id),
        json={"clientMutationId": f"cmid-{uuid4()}", "displayName": "Blocked Rename"},
    )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "E_FORBIDDEN"


@pytest.mark.integration
def test_rename_invisible_contributor_returns_404(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db)
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Rename Hidden {uuid4()}"
    )
    outsider_id, _ = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    response = auth_client.patch(
        f"/contributors/{handle}",
        headers=auth_headers(outsider_id, nexus_roles=["contributor_curator"]),
        json={"clientMutationId": f"cmid-{uuid4()}", "displayName": "Unseen Rename"},
    )
    assert response.status_code == 404, response.text


@pytest.mark.integration
def test_rename_by_curator_updates_display_name_and_keeps_handle(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    curator_headers = auth_headers(owner_id, nexus_roles=["contributor_curator"])
    original = f"Original Name {uuid4()}"
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=original
    )
    response = auth_client.patch(
        f"/contributors/{handle}",
        headers=curator_headers,
        json={"clientMutationId": f"cmid-{uuid4()}", "displayName": "Renamed Author"},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["handle"] == handle
    assert data["displayName"] == "Renamed Author"
    assert data["canRename"] is True
    assert original in data["otherNames"]


@pytest.mark.integration
def test_rename_replay_returns_recorded_response_after_later_change(auth_client, direct_db):
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    headers = auth_headers(owner_id, nexus_roles=["contributor_curator"])
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Rename Replay {uuid4()}"
    )
    cmid = f"cmid-{uuid4()}"

    to_b = auth_client.patch(
        f"/contributors/{handle}",
        headers=headers,
        json={"clientMutationId": cmid, "displayName": "Name B"},
    )
    assert to_b.status_code == 200, to_b.text

    to_c = auth_client.patch(
        f"/contributors/{handle}",
        headers=headers,
        json={"clientMutationId": f"cmid-{uuid4()}", "displayName": "Name C"},
    )
    assert to_c.status_code == 200, to_c.text

    replay = auth_client.patch(
        f"/contributors/{handle}",
        headers=headers,
        json={"clientMutationId": cmid, "displayName": "Name B"},
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["data"]["displayName"] == "Name B"

    # Current state is still C — replay did not revert it.
    current = auth_client.get(f"/contributors/{handle}", headers=headers)
    assert current.json()["data"]["displayName"] == "Name C"


@pytest.mark.integration
def test_rename_authorizes_before_replay_lookup(auth_client, direct_db):
    # D-44: an unauthorized viewer replaying a real memo key still gets 403, never
    # the recorded response.
    owner_id, owner_library = _bootstrap_user(auth_client, direct_db, roles=["contributor_curator"])
    curator_headers = auth_headers(owner_id, nexus_roles=["contributor_curator"])
    _media_id, handle = _seed_author(
        auth_client, direct_db, owner_id, owner_library, credited_name=f"Auth First {uuid4()}"
    )
    cmid = f"cmid-{uuid4()}"
    recorded = auth_client.patch(
        f"/contributors/{handle}",
        headers=curator_headers,
        json={"clientMutationId": cmid, "displayName": "Curated Rename"},
    )
    assert recorded.status_code == 200, recorded.text

    # The creator sees the contributor but is not a curator: 403 before replay.
    replayed = auth_client.patch(
        f"/contributors/{handle}",
        headers=auth_headers(owner_id),
        json={"clientMutationId": cmid, "displayName": "Curated Rename"},
    )
    assert replayed.status_code == 403, replayed.text
