"""Integration tests for GET /media/{id}/related (collection surface, spec S5).

The related-media path is deterministic and AI-free: peers come from precomputed
``content_embeddings`` (media-owner-seeded nearest-neighbours) unioned with
``contributor_credits`` shared-author media. These tests assert both signals
contribute, that the result is stable for identical input, and — by hard-failing
every LLM/provider entrypoint for the duration of the request — that no
request-time provider call happens on this path.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest

import nexus.services.llm_execution as llm_execution
import nexus.services.semantic_chunks as semantic_chunks
from nexus.services import contributors as contributors_service
from nexus.services.contributor_taxonomy import ContributorObservation, ObservedRoleSlices
from tests.factories import create_searchable_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

RELATED_KEYS = {"peers"}
PEER_KEYS = {"ref", "scheme", "id", "label", "description", "activation", "href", "missing"}


def _seed_media(direct_db: DirectSessionManager, user_id: UUID, *, title: str, text: str) -> UUID:
    """Create ready, embedded media (default-library intrinsic) for ``user_id``.

    ``create_searchable_media`` derives the canonical text from ``title``, so two
    media built from the same title get identical chunk vectors (cosine distance
    0) — the deterministic similarity fixture. ``text`` lets a caller force two
    titles to differ while sharing nothing semantically.
    """
    with direct_db.session() as session:
        media_id = create_searchable_media(session, user_id, title=f"{title} {text}")
    # The content_chunks(owner_id) cleanup cascades to content_embeddings +
    # content_chunk_parts via their chunks (see tests/utils/db.py).
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _set_author(direct_db: DirectSessionManager, media_id: UUID, *, name: str) -> None:
    # Observe a single author via the facade (fresh session inside). The
    # contributor/alias rows it creates are cleaned with the media row's credits
    # (tests.utils.db deletes contributor_credits by media_id on media teardown).
    contributors_service.replace_observed_role_slices(
        target=contributors_service.MediaTarget(media_id),
        observation=ObservedRoleSlices(
            managed_roles=frozenset({"author"}),
            credits=(
                ContributorObservation(
                    credited_name=name, role="author", raw_role=None, identity_key=None
                ),
            ),
        ),
        source="epub_opf",
    )


def _ban_provider_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every LLM/provider entrypoint raise for the rest of the test.

    The related path must touch none of these: ``build_text_embeddings`` is an
    ingest-time call and ``llm_execution`` is the sole provider-execution
    substrate. Seeding must happen BEFORE this installs (seeding embeds).
    """

    def _boom(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("request-time provider/LLM call on the related path")

    monkeypatch.setattr(semantic_chunks, "build_text_embeddings", _boom)
    monkeypatch.setattr(semantic_chunks, "build_text_embedding", _boom)
    monkeypatch.setattr(llm_execution, "execute_generation", _boom)
    monkeypatch.setattr(llm_execution, "execute_generation_stream", _boom)


def _related(auth_client, user_id: UUID, media_id: UUID, **params):
    return auth_client.get(
        f"/media/{media_id}/related",
        headers=auth_headers(user_id),
        params=params,
    )


def test_related_returns_similarity_and_shared_author_peers_without_provider_call(
    auth_client, direct_db: DirectSessionManager, monkeypatch: pytest.MonkeyPatch
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    subject = _seed_media(direct_db, user_id, title="Attention Transformers", text="alpha")
    # A semantic twin: identical canonical text -> identical chunk vectors -> distance 0.
    similar = _seed_media(direct_db, user_id, title="Attention Transformers", text="alpha")
    # A shared-author peer with unrelated text (only the author connects it).
    shared_author = _seed_media(direct_db, user_id, title="Compost Gardening", text="bravo")
    # An unrelated peer: different text, different author -> must NOT surface.
    _unrelated = _seed_media(direct_db, user_id, title="Tax Accounting", text="charlie")

    _set_author(direct_db, subject, name="Ada Lovelace")
    _set_author(direct_db, shared_author, name="Ada Lovelace")

    _ban_provider_calls(monkeypatch)
    response = _related(auth_client, user_id, subject)

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert set(data) == RELATED_KEYS, f"payload keys must be {sorted(RELATED_KEYS)}; got {data}"
    peers = data["peers"]
    peer_refs = [peer["ref"] for peer in peers]
    assert peers, "expected related peers"
    for peer in peers:
        assert set(peer) == PEER_KEYS, f"peer keys must be {sorted(PEER_KEYS)}; got {peer}"

    assert f"media:{similar}" in peer_refs, "the semantic twin must surface (similarity signal)"
    assert f"media:{shared_author}" in peer_refs, "the shared-author peer must surface"
    assert f"media:{subject}" not in peer_refs, "the target must never be its own peer"

    # Deterministic order: the distance-0 similarity twin outranks the
    # similarity-less shared-author-only peer.
    assert peer_refs.index(f"media:{similar}") < peer_refs.index(f"media:{shared_author}")

    # Peers are hydrated live: label + a route href, not missing.
    similar_peer = next(peer for peer in peers if peer["ref"] == f"media:{similar}")
    assert similar_peer["missing"] is False
    assert similar_peer["label"], "peer must carry a hydrated label"
    assert similar_peer["href"] == f"/media/{similar}"


def test_related_is_stable_for_identical_input(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    subject = _seed_media(direct_db, user_id, title="Stable Subject", text="alpha")
    _twin_a = _seed_media(direct_db, user_id, title="Stable Subject", text="alpha")
    _twin_b = _seed_media(direct_db, user_id, title="Stable Subject", text="alpha")
    author_peer = _seed_media(direct_db, user_id, title="Other Topic", text="bravo")
    _set_author(direct_db, subject, name="Grace Hopper")
    _set_author(direct_db, author_peer, name="Grace Hopper")

    first = _related(auth_client, user_id, subject)
    second = _related(auth_client, user_id, subject)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_refs = [peer["ref"] for peer in first.json()["data"]["peers"]]
    second_refs = [peer["ref"] for peer in second.json()["data"]["peers"]]
    assert first_refs == second_refs, "related order must be stable for identical input"


def test_related_clamps_limit_and_masks_unreadable_target(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    subject = _seed_media(direct_db, user_id, title="Limit Subject", text="alpha")

    # limit outside the clamp bounds (1..20) is rejected at the boundary; the app
    # maps the validation error to 400 E_INVALID_REQUEST (not a bare 422).
    too_big = _related(auth_client, user_id, subject, limit=999)
    assert too_big.status_code == 400, too_big.text
    assert too_big.json()["error"]["code"] == "E_INVALID_REQUEST"
    too_small = _related(auth_client, user_id, subject, limit=0)
    assert too_small.status_code == 400, too_small.text

    # A non-readable / unknown media id is masked as 404 (no existence leak).
    missing = _related(auth_client, user_id, uuid4())
    assert missing.status_code == 404, missing.text
