"""Search-package contributor retriever behavior after the author-dedup cutover.

The retriever composes the canonical credit relation
(``contributor_credits.visible_credit_rows_sql`` + ``contributor_fts_text_sql``)
and the credited-visible predicate (D-8). These tests assert the observable
guarantees: scope narrows the candidate set, a retained key-owner with zero
visible credits is undiscoverable (D-8/AC 19/25), external keys never enter the
FTS blob or a snippet (AC 24), and one person in two roles on one work is a single
contributor hit (AC 12).

Contributors are created the way the product creates them — an automatic observed
role-slice replacement through the facade, which opens its own fresh session and
commits — so seeding and the search reads use ``direct_db`` (separate connections
that see committed data).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.services import contributors
from nexus.services import search as search_service
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import contributor_fts_text_sql
from nexus.services.contributor_taxonomy import (
    ContributorIdentityKey,
    ContributorObservation,
    ObservedRoleSlices,
    canonicalize_identity_key,
)
from nexus.services.search.query import SearchQuery, SearchScope
from nexus.services.search.scope import parse_scope
from nexus.services.search.sql import contributor_credits_rollup_cte_sql
from tests.factories import create_test_media_in_library

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _bootstrap_viewer(direct_db) -> tuple[UUID, UUID]:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    with direct_db.session() as session:
        default_library_id = ensure_user_and_default_library(session, user_id)
        session.commit()
    return user_id, default_library_id


def _seed_media(direct_db, user_id: UUID, library_id: UUID, *, title: str) -> UUID:
    with direct_db.session() as session:
        media_id = create_test_media_in_library(session, user_id, library_id, title=title)
        session.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)
    return media_id


def _track_contributor(direct_db, contributor_id: UUID) -> None:
    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)


def _observe(direct_db, media_id: UUID, observation, *, source: str = "epub_opf") -> None:
    contributors.replace_observed_role_slices(
        target=contributors.MediaTarget(media_id), observation=observation, source=source
    )
    with direct_db.session() as session:
        ids = [
            row[0]
            for row in session.execute(
                text("SELECT DISTINCT contributor_id FROM contributor_credits WHERE media_id = :m"),
                {"m": media_id},
            )
        ]
    for contributor_id in ids:
        _track_contributor(direct_db, contributor_id)


def _key(authority: str, raw: str) -> ContributorIdentityKey:
    canonical = canonicalize_identity_key(authority, raw)
    assert canonical is not None, (authority, raw)
    return ContributorIdentityKey(authority=authority, key=canonical)


def _author_obs(name: str, *, key: ContributorIdentityKey | None = None) -> ObservedRoleSlices:
    return ObservedRoleSlices(
        managed_roles=frozenset({"author"}),
        credits=(
            ContributorObservation(
                credited_name=name, role="author", raw_role=None, identity_key=key
            ),
        ),
    )


def _people_search(direct_db, user_id: UUID, query: str, *, scope: str = "all") -> list:
    scope_type, scope_id = parse_scope(scope)
    with direct_db.session() as session:
        response = search_service.search(
            session,
            user_id,
            SearchQuery(
                text=query,
                scope=SearchScope(kind=scope_type, id=scope_id),
                requested_kinds=frozenset({"people"}),
            ),
        )
    return response.results


def _contributor_handles(results) -> set[str]:
    return {r.contributor_handle for r in results if r.type == "contributor"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_scope_narrows_candidates_to_contributors_credited_in_scope(direct_db):
    """A media scope only surfaces contributors credited within that media."""
    user_id, library_id = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:10]
    in_scope_media = _seed_media(direct_db, user_id, library_id, title=f"In scope {uuid4()}")
    out_scope_media = _seed_media(direct_db, user_id, library_id, title=f"Out scope {uuid4()}")

    _observe(direct_db, in_scope_media, _author_obs(f"Alpha Scopename {token}"))
    _observe(direct_db, out_scope_media, _author_obs(f"Beta Scopename {token}"))

    # Searching the out-of-scope contributor's name inside the in-scope media finds
    # nothing: it is not a candidate there.
    in_scope_hits = _people_search(
        direct_db, user_id, f"Beta Scopename {token}", scope=f"media:{in_scope_media}"
    )
    assert [r.type for r in in_scope_hits] == []

    # In its own media scope the contributor is a candidate and matches.
    out_scope_hits = _people_search(
        direct_db, user_id, f"Beta Scopename {token}", scope=f"media:{out_scope_media}"
    )
    assert [r.type for r in out_scope_hits] == ["contributor"]


@pytest.mark.integration
def test_zero_work_key_owner_is_absent_from_search(direct_db):
    """A retained key owner with zero visible credits never surfaces (D-8/AC 19/25)."""
    user_id, library_id = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:10]
    media_id = _seed_media(direct_db, user_id, library_id, title=f"Keyed work {uuid4()}")

    keyed_name = f"Keyed Owner {token}"
    orcid = _key("orcid", "0000-0002-1825-0097")
    _observe(direct_db, media_id, _author_obs(keyed_name, key=orcid))

    # While credited, the keyed contributor is discoverable.
    assert _contributor_handles(_people_search(direct_db, user_id, keyed_name))

    # Replace the author slice with a different person. The keyed owner keeps its
    # external id (so it is retained, not pruned) but now has zero credits.
    replacement_name = f"Replacement Author {token}"
    _observe(direct_db, media_id, _author_obs(replacement_name))

    with direct_db.session() as session:
        remaining = session.execute(
            text("SELECT id FROM contributors WHERE display_name = :n"),
            {"n": keyed_name},
        ).all()
    assert remaining, "keyed owner must be retained (has an external id), not pruned"

    # The retained zero-work key owner is now undiscoverable; the replacement is found.
    assert not _contributor_handles(_people_search(direct_db, user_id, keyed_name))
    assert _contributor_handles(_people_search(direct_db, user_id, replacement_name))


@pytest.mark.integration
def test_external_key_never_enters_fts_or_snippet(direct_db):
    """External keys are neither searchable nor present in any FTS blob/snippet (AC 24)."""
    user_id, library_id = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:10]
    media_id = _seed_media(direct_db, user_id, library_id, title=f"Keyed FTS work {uuid4()}")

    name = f"Fts Guarded Author {token}"
    external_key = "0000-0002-1825-0097"
    _observe(direct_db, media_id, _author_obs(name, key=_key("orcid", external_key)))

    with direct_db.session() as session:
        contributor_id = session.execute(
            text("SELECT id FROM contributors WHERE display_name = :n"), {"n": name}
        ).scalar_one()
        fts_rows = session.execute(
            text(f"SELECT contributor_id, search_text FROM ({contributor_fts_text_sql()}) fts"),
            {"viewer_id": user_id},
        ).all()
        rollup_rows = session.execute(
            text(
                f"""
                SELECT media_id, contributor_search_text
                FROM ({contributor_credits_rollup_cte_sql("media_id")}) rollup
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).all()

    fts_by_id = {row[0]: row[1] or "" for row in fts_rows}
    assert name.split()[0] in fts_by_id[contributor_id]
    assert external_key not in fts_by_id[contributor_id]

    assert rollup_rows, "media rollup must include the credited contributor"
    assert external_key not in (rollup_rows[0][1] or "")

    # A search for the key text yields no contributor, and a name search's snippet
    # carries no external key.
    assert not _contributor_handles(_people_search(direct_db, user_id, external_key))
    name_hits = [r for r in _people_search(direct_db, user_id, name) if r.type == "contributor"]
    assert name_hits, "the contributor must be findable by name"
    assert external_key not in name_hits[0].snippet


@pytest.mark.integration
def test_one_person_two_roles_is_a_single_contributor_hit(direct_db):
    """A person credited as author and editor on one work is one contributor result (AC 12)."""
    user_id, library_id = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:10]
    media_id = _seed_media(direct_db, user_id, library_id, title=f"Two-role work {uuid4()}")

    name = f"Dual Role Person {token}"
    key = _key("openalex", f"W{uuid4().hex}")
    observation = ObservedRoleSlices(
        managed_roles=frozenset({"author", "editor"}),
        credits=(
            ContributorObservation(
                credited_name=name, role="author", raw_role=None, identity_key=key
            ),
            ContributorObservation(
                credited_name=name, role="editor", raw_role=None, identity_key=key
            ),
        ),
    )
    _observe(direct_db, media_id, observation)

    with direct_db.session() as session:
        role_count = session.execute(
            text("SELECT count(*) FROM contributor_credits WHERE media_id = :m"),
            {"m": media_id},
        ).scalar_one()
    assert role_count == 2, "both role facts persist"

    hits = [r for r in _people_search(direct_db, user_id, name) if r.type == "contributor"]
    assert len(hits) == 1, "the person appears exactly once despite two role facts"


@pytest.mark.integration
def test_durable_ref_reresolves_edge_only_zero_credit_contributor(direct_db):
    """A chat-cited contributor reachable only via a viewer-owned graph edge, with zero
    visible credits, still re-materializes through ``get_search_result`` (M2 / D-8).

    The discovery surface keeps hiding it (credited-visible), but the id-pinned
    durable-ref mode uses broad visibility — matching hydration / ``_load_contributor`` —
    so its citation chip does not silently vanish on reload.
    """
    user_id, library_id = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:10]
    media_id = _seed_media(direct_db, user_id, library_id, title=f"Edge-ref work {uuid4()}")

    keyed_name = f"Edge Referenced {token}"
    _observe(direct_db, media_id, _author_obs(keyed_name))

    with direct_db.session() as session:
        contributor_id = session.execute(
            text("SELECT id FROM contributors WHERE display_name = :n"), {"n": keyed_name}
        ).scalar_one()

    # A viewer-owned note-body graph edge with this contributor as its target endpoint —
    # the shape the real note-embed sync writes (note_block -> contributor). It is the only
    # thing keeping the contributor alive once its credit is replaced (no external id).
    note_block_id = uuid4()
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO resource_edges
                    (user_id, kind, origin, source_scheme, source_id, target_scheme, target_id)
                VALUES
                    (:user_id, 'context', 'note_body', 'note_block', :nbid, 'contributor', :cid)
                """
            ),
            {"user_id": user_id, "nbid": note_block_id, "cid": contributor_id},
        )
        session.commit()
    direct_db.register_cleanup("resource_edges", "target_id", contributor_id)

    # Replace the author slice; the edge-referenced contributor keeps zero visible credits
    # but is retained (the edge blocks the orphan prune).
    _observe(direct_db, media_id, _author_obs(f"Replacement {token}"))
    with direct_db.session() as session:
        assert session.execute(
            text("SELECT 1 FROM contributors WHERE id = :cid"), {"cid": contributor_id}
        ).first(), "edge-referenced contributor must be retained, not pruned"

    # Discovery still hides it (credited-visible gate) ...
    assert not _contributor_handles(_people_search(direct_db, user_id, keyed_name))

    # ... but the durable-ref re-resolution succeeds (broad visibility).
    with direct_db.session() as session:
        resolved = search_service.get_search_result(
            db=session,
            viewer_id=user_id,
            result_type="contributor",
            result_id=str(contributor_id),
        )
    assert resolved.contributor_handle
    assert resolved.type == "contributor"
