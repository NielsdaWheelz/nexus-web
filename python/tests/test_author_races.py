"""Two-session concurrency coverage for the author-deduplication facade (spec 2.7).

Each mutation facade opens its own fresh session and terminates in
``retry_serializable`` (D-11/D-22), so the *whole operation* is the race window:
uniqueness collisions surface as ``40001`` / allowlisted ``IntegrityError`` and
the operation re-runs against a fresh snapshot until it converges. These tests
drive the facade from independent OS threads gated by a ``threading.Barrier``
(the proven ``direct_db`` precedent) and assert both that the outcome converges
*and* that no orphan identity/alias/credit rows leak. No sleeps; generous joins.

Scenarios:

1. Same-name first sight -> exactly one contributor (``uq_contributors_handle``
   retry), both credits point at it, one resolving alias.
2. Same-key first sight -> one contributor, the key attached once
   (``uq_contributor_external_ids_authority_key`` retry), both spellings aliased.
3. Automatic vs manual -> the manual slice is always final and the media stays
   pinned, under both deterministic orderings and a true barrier race; two
   concurrent manual saves resolve to a single clean last-committed winner.
"""

from __future__ import annotations

import threading
from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.auth.middleware import Viewer
from nexus.schemas.contributors import ManualMediaAuthorsRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_taxonomy import (
    ContributorIdentityKey,
    ContributorObservation,
    ObservedRoleSlices,
    canonicalize_identity_key,
)
from nexus.services.contributors import (
    MediaTarget,
    put_media_authors,
    replace_observed_role_slices,
)
from tests.factories import create_test_media, create_test_media_in_library
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Concurrency harness + builders
# ---------------------------------------------------------------------------


def _run_concurrently(targets):
    """Run zero-arg callables on independent threads, released by one barrier.

    Every facade call opens its own session/connection, so barrier-before-call is
    enough to overlap the operations and exercise the whole-op uniqueness retry.
    Any worker exception (including a broken barrier) is surfaced as a failure.
    """
    barrier = threading.Barrier(len(targets))
    errors: list[BaseException] = []
    lock = threading.Lock()

    def _wrap(fn):
        try:
            barrier.wait(timeout=10)
            fn()
        except BaseException as exc:  # pragma: no cover - re-raised via the assert below
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=_wrap, args=(fn,)) for fn in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    for thread in threads:
        if thread.is_alive():
            errors.append(AssertionError(f"worker thread did not finish: {thread.name}"))

    assert errors == [], f"concurrent workers raised: {errors!r}"


def _author_observation(name, *, key=None):
    return ObservedRoleSlices(
        managed_roles=frozenset({"author"}),
        credits=(
            ContributorObservation(
                credited_name=name, role="author", raw_role=None, identity_key=key
            ),
        ),
    )


def _manual_new_author_request(name):
    """A manual PUT that creates a single ``new`` author (strict camelCase wire)."""
    return ManualMediaAuthorsRequest.model_validate(
        {
            "clientMutationId": f"cmid-{uuid4()}",
            "mode": "manual",
            "authors": [{"creditedName": name, "binding": {"kind": "new", "displayName": name}}],
        }
    )


# ---------------------------------------------------------------------------
# Fixtures / seeding (direct_db: real commits, independent connections)
# ---------------------------------------------------------------------------


def _bootstrap_owner(direct_db):
    """Create a persisted user + default library and return their ``Viewer``."""
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    with direct_db.session() as session:
        library_id = ensure_user_and_default_library(session, user_id)
    return Viewer(user_id=user_id, default_library_id=library_id, roles=frozenset())


def _bare_media(direct_db, title):
    """A media row with no owner — enough for the automatic (viewer-less) lane."""
    with direct_db.session() as session:
        media_id = create_test_media(session, title=title)
    # media cleanup cascades its contributor_credits + library_entries.
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _owned_media(direct_db, viewer, title):
    """A media row created by ``viewer`` in their default library (creator can edit)."""
    with direct_db.session() as session:
        media_id = create_test_media_in_library(
            session, viewer.user_id, viewer.default_library_id, title=title
        )
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _register_contributor_cleanup(direct_db, contributor_ids):
    """Register LIFO cleanup so credits/aliases/keys delete before the row itself."""
    for contributor_id in contributor_ids:
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------


def _contributor_ids_by_name(session, names):
    return [
        row.id
        for row in session.execute(
            text(
                "SELECT id FROM contributors WHERE display_name = ANY(:names) "
                "ORDER BY created_at, id"
            ),
            {"names": list(names)},
        )
    ]


def _credit_rows_for_media(session, media_id):
    return session.execute(
        text(
            """
            SELECT contributor_id, credited_name, role, ordinal
            FROM contributor_credits
            WHERE media_id = :media_id
            ORDER BY ordinal
            """
        ),
        {"media_id": media_id},
    ).fetchall()


def _alias_literals(session, contributor_id):
    return {
        row.alias
        for row in session.execute(
            text("SELECT alias FROM contributor_aliases WHERE contributor_id = :c"),
            {"c": contributor_id},
        )
    }


def _media_is_pinned(session, media_id):
    return session.execute(
        text("SELECT authors_manually_managed FROM media WHERE id = :m"),
        {"m": media_id},
    ).scalar_one()


def _assert_manual_slice_final(direct_db, media_id, expected_credited_name, cleanup_names):
    """The media carries exactly the one manual author and stays pinned."""
    with direct_db.session() as session:
        _register_contributor_cleanup(direct_db, _contributor_ids_by_name(session, cleanup_names))
        rows = _credit_rows_for_media(session, media_id)
        assert [row.credited_name for row in rows] == [expected_credited_name], rows
        assert [row.ordinal for row in rows] == [0], rows
        assert _media_is_pinned(session, media_id) is True


# ---------------------------------------------------------------------------
# Scenario 1 — same-name first sight (uq_contributors_handle retry)
# ---------------------------------------------------------------------------


def test_same_name_first_sight_converges_to_one_contributor(direct_db):
    name = f"Race Same Name {uuid4()}"
    media_a = _bare_media(direct_db, f"Same-Name Work A {uuid4()}")
    media_b = _bare_media(direct_db, f"Same-Name Work B {uuid4()}")
    observation = _author_observation(name)

    # Symmetric race: both sessions resolve the same never-seen name at once. The
    # loser collides on the deterministic base handle, rolls back, and on the
    # fresh snapshot resolves to the winner via its resolving alias.
    _run_concurrently(
        [
            lambda: replace_observed_role_slices(
                target=MediaTarget(media_a), observation=observation, source="rss"
            ),
            lambda: replace_observed_role_slices(
                target=MediaTarget(media_b), observation=observation, source="rss"
            ),
        ]
    )

    with direct_db.session() as session:
        ids = _contributor_ids_by_name(session, [name])
        _register_contributor_cleanup(direct_db, ids)

        assert len(ids) == 1, f"expected a single contributor for {name!r}, got {ids}"
        contributor_id = ids[0]

        rows_a = _credit_rows_for_media(session, media_a)
        rows_b = _credit_rows_for_media(session, media_b)
        assert [row.contributor_id for row in rows_a] == [contributor_id]
        assert [row.contributor_id for row in rows_b] == [contributor_id]
        assert [row.ordinal for row in rows_a] == [0]
        assert [row.ordinal for row in rows_b] == [0]
        assert rows_a[0].credited_name == name
        assert rows_b[0].credited_name == name

        # No orphan aliases: the observed spelling equals the canonical display,
        # so exactly one (resolving) alias row exists.
        aliases = session.execute(
            text(
                "SELECT alias, resolves_identity FROM contributor_aliases WHERE contributor_id = :c"
            ),
            {"c": contributor_id},
        ).fetchall()
        assert [(a.alias, a.resolves_identity) for a in aliases] == [(name, True)]


# ---------------------------------------------------------------------------
# Scenario 2 — same-key first sight (uq_contributor_external_ids_authority_key)
# ---------------------------------------------------------------------------


def test_same_key_first_sight_attaches_key_once(direct_db):
    canonical_key = canonicalize_identity_key(
        "email_address", f"Race.Key.{uuid4().hex}@Example.COM"
    )
    assert canonical_key is not None
    key = ContributorIdentityKey(authority="email_address", key=canonical_key)

    # Different spellings (punctuation is significant), so only the shared key can
    # collapse them onto one identity.
    name_a = f"Doctor Keyed Race {uuid4()}"
    name_b = f"Dr. Keyed Race {uuid4()}"
    media_a = _bare_media(direct_db, f"Same-Key Work A {uuid4()}")
    media_b = _bare_media(direct_db, f"Same-Key Work B {uuid4()}")

    _run_concurrently(
        [
            lambda: replace_observed_role_slices(
                target=MediaTarget(media_a),
                observation=_author_observation(name_a, key=key),
                source="metadata_enrichment",
            ),
            lambda: replace_observed_role_slices(
                target=MediaTarget(media_b),
                observation=_author_observation(name_b, key=key),
                source="metadata_enrichment",
            ),
        ]
    )

    with direct_db.session() as session:
        ids = _contributor_ids_by_name(session, [name_a, name_b])
        _register_contributor_cleanup(direct_db, ids)

        key_owner_ids = [
            row.contributor_id
            for row in session.execute(
                text(
                    "SELECT contributor_id FROM contributor_external_ids "
                    "WHERE authority = 'email_address' AND external_key = :k"
                ),
                {"k": canonical_key},
            )
        ]
        assert len(key_owner_ids) == 1, f"key attached more than once: {key_owner_ids}"
        contributor_id = key_owner_ids[0]
        assert ids == [contributor_id], f"expected one keyed contributor, got {ids}"

        rows_a = _credit_rows_for_media(session, media_a)
        rows_b = _credit_rows_for_media(session, media_b)
        assert [row.contributor_id for row in rows_a] == [contributor_id]
        assert [row.contributor_id for row in rows_b] == [contributor_id]
        # Each work keeps the spelling it was credited under...
        assert rows_a[0].credited_name == name_a
        assert rows_b[0].credited_name == name_b
        # ...and both spellings are searchable aliases under the one identity.
        assert {name_a, name_b} <= _alias_literals(session, contributor_id)


# ---------------------------------------------------------------------------
# Scenario 3 — automatic vs manual: the manual slice always wins
# ---------------------------------------------------------------------------


def test_automatic_after_manual_preserves_pinned_manual_slice(direct_db):
    """Deterministic ordering: manual pins first, a later automatic op no-ops."""
    viewer = _bootstrap_owner(direct_db)
    manual_name = f"Manual Author {uuid4()}"
    auto_name = f"Automatic Author {uuid4()}"
    media_id = _owned_media(direct_db, viewer, f"Manual-First Work {uuid4()}")

    put_media_authors(
        viewer=viewer, media_id=media_id, request=_manual_new_author_request(manual_name)
    )
    replace_observed_role_slices(
        target=MediaTarget(media_id), observation=_author_observation(auto_name), source="rss"
    )

    _assert_manual_slice_final(direct_db, media_id, manual_name, [manual_name, auto_name])


def test_manual_after_automatic_overrides_automatic_slice(direct_db):
    """Deterministic ordering: automatic writes first, manual replaces + prunes it."""
    viewer = _bootstrap_owner(direct_db)
    manual_name = f"Manual Author {uuid4()}"
    auto_name = f"Automatic Author {uuid4()}"
    media_id = _owned_media(direct_db, viewer, f"Automatic-First Work {uuid4()}")

    replace_observed_role_slices(
        target=MediaTarget(media_id), observation=_author_observation(auto_name), source="rss"
    )
    put_media_authors(
        viewer=viewer, media_id=media_id, request=_manual_new_author_request(manual_name)
    )

    _assert_manual_slice_final(direct_db, media_id, manual_name, [manual_name, auto_name])
    # The displaced automatic author had no credit/key/reference left, so it was
    # pruned rather than left orphaned.
    with direct_db.session() as session:
        assert _contributor_ids_by_name(session, [auto_name]) == []


def test_concurrent_automatic_and_manual_manual_always_wins(direct_db):
    """True race: whichever commits first, the pinned manual slice is final."""
    viewer = _bootstrap_owner(direct_db)
    manual_name = f"Manual Author {uuid4()}"
    auto_name = f"Automatic Author {uuid4()}"
    media_id = _owned_media(direct_db, viewer, f"Concurrent Author Work {uuid4()}")
    request = _manual_new_author_request(manual_name)
    observation = _author_observation(auto_name)

    # If manual commits first the automatic op re-reads the pin and skips the
    # author role; if automatic commits first the manual op replaces and prunes
    # it. Either interleaving converges on the manual slice.
    _run_concurrently(
        [
            lambda: replace_observed_role_slices(
                target=MediaTarget(media_id), observation=observation, source="rss"
            ),
            lambda: put_media_authors(viewer=viewer, media_id=media_id, request=request),
        ]
    )

    _assert_manual_slice_final(direct_db, media_id, manual_name, [manual_name, auto_name])


def test_concurrent_manual_saves_last_committed_writer_wins(direct_db):
    """Two manual saves race the same slice; one clean winner, no merged rows."""
    viewer = _bootstrap_owner(direct_db)
    name_a = f"Manual Save A {uuid4()}"
    name_b = f"Manual Save B {uuid4()}"
    media_id = _owned_media(direct_db, viewer, f"Manual Save Race {uuid4()}")
    request_a = _manual_new_author_request(name_a)
    request_b = _manual_new_author_request(name_b)

    _run_concurrently(
        [
            lambda: put_media_authors(viewer=viewer, media_id=media_id, request=request_a),
            lambda: put_media_authors(viewer=viewer, media_id=media_id, request=request_b),
        ]
    )

    with direct_db.session() as session:
        ids = _contributor_ids_by_name(session, [name_a, name_b])
        _register_contributor_cleanup(direct_db, ids)
        rows = _credit_rows_for_media(session, media_id)
        assert len(rows) == 1, f"expected exactly one winning author row, got {rows}"
        assert rows[0].ordinal == 0
        assert rows[0].credited_name in {name_a, name_b}
        assert _media_is_pinned(session, media_id) is True
        # The losing save's identity was dropped from the slice but its own
        # committed replay memo still names it (spec 2.8): it must survive as a
        # zero-credit identity so replaying that PUT never dangles.
        assert len(ids) == 2, (
            f"the losing manual author must be kept alive by its replay memo, got {ids}"
        )
