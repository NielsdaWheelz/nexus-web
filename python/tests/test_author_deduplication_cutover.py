"""Service-level behavior for the lightweight author-deduplication cutover.

This exercises the public author facade (``nexus.services.contributors``) and the
typed observation values (``nexus.services.contributor_taxonomy``) directly, so it
covers resolver/replacement/replay/cleanup behavior the HTTP surface can only
reach indirectly. The FastAPI route surface lives in ``test_contributors.py`` and
the two-session races in ``test_author_races.py``.

Everything asserts observed behavior — which identity a work is credited to, what
survives a replacement, whether a memo replays — never the resolver's internals.
Contributors are created the way the product creates them: an automatic observed
role-slice replacement, or a manual media-author PUT. The mutation facades open
their own fresh session and commit, so seeding and assertions use ``direct_db``
(separate connections that see committed data).

Coverage map (spec §10 acceptance criteria):
- AC 1-7  : the exact batch resolver (`replace_observed_role_slices`).
- AC 10,11,13,15,16,17,19 : role-slice replacement / pin / reset / no-DML / replay
  / cleanup at the service level.
- AC 22   : rename replay after an intervening rename.
- D-41/42/43/44 : orphan-prune gating, replay re-validation, memo-absence across a
  forced retry, and rename authorization before replay.
"""

from __future__ import annotations

from contextlib import contextmanager
from uuid import uuid4

import pytest
from sqlalchemy import event, text, update

from nexus.auth.middleware import Viewer
from nexus.db.engine import get_engine
from nexus.db.models import ResourceEdge, ResourceMutation
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError
from nexus.schemas.contributors import (
    AutomaticMediaAuthorsRequest,
    ContributorRenameRequest,
    ManualMediaAuthorsRequest,
)
from nexus.services import contributors
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorIdentityKey,
    ContributorObservation,
    ObservedRoleSlices,
    canonicalize_identity_key,
    contributor_match_key,
    parse_contributor_handle,
)
from tests.factories import create_test_media_in_library

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _bootstrap_viewer(direct_db, *, roles=frozenset()):
    """Create a user + default library and return an authenticated ``Viewer``."""
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    with direct_db.session() as session:
        default_library_id = ensure_user_and_default_library(session, user_id)
        session.commit()
    return Viewer(user_id=user_id, default_library_id=default_library_id, roles=frozenset(roles))


def _seed_media(direct_db, viewer, *, title=None):
    """Seed a ready media owned by (and visible to) ``viewer`` and register cleanup."""
    with direct_db.session() as session:
        media_id = create_test_media_in_library(
            session, viewer.user_id, viewer.default_library_id, title=title or f"Work {uuid4()}"
        )
        session.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)
    return media_id


def _track_contributor(direct_db, contributor_id):
    # LIFO cleanup: register the credit (by contributor) LAST so it deletes before
    # the contributor row it references. Duplicate registrations are harmless.
    direct_db.register_cleanup("contributors", "id", contributor_id)
    direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)


def _track_media_contributors(direct_db, media_id):
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


def _key(authority, raw):
    canonical = canonicalize_identity_key(authority, raw)
    assert canonical is not None, (authority, raw)
    return ContributorIdentityKey(authority=authority, key=canonical)


def _openalex_key():
    return _key("openalex", f"W{uuid4().hex}")


def _obs(*rows, managed_roles=None):
    """Build an ``ObservedRoleSlices`` from ``(credited_name, role, key)`` rows."""
    credits = tuple(
        ContributorObservation(credited_name=name, role=role, raw_role=None, identity_key=key)
        for name, role, key in rows
    )
    roles = (
        frozenset(managed_roles) if managed_roles is not None else frozenset(r for _, r, _ in rows)
    )
    return ObservedRoleSlices(managed_roles=roles, credits=credits)


def _author_obs(*names_or_pairs):
    """Author-only observation. Each item is a name, or a ``(name, key)`` pair."""
    rows = []
    for item in names_or_pairs:
        name, key = item if isinstance(item, tuple) else (item, None)
        rows.append((name, "author", key))
    return _obs(*rows)


def _observe(direct_db, media_id, observation, *, source="epub_opf"):
    contributors.replace_observed_role_slices(
        target=contributors.MediaTarget(media_id), observation=observation, source=source
    )
    _track_media_contributors(direct_db, media_id)


def _credits(direct_db, media_id):
    with direct_db.session() as session:
        rows = (
            session.execute(
                text(
                    "SELECT contributor_id, credited_name, role, raw_role, ordinal "
                    "FROM contributor_credits WHERE media_id = :m ORDER BY ordinal"
                ),
                {"m": media_id},
            )
            .mappings()
            .all()
        )
    return [dict(row) for row in rows]


def _names_for_role(direct_db, media_id, role):
    return [c["credited_name"] for c in _credits(direct_db, media_id) if c["role"] == role]


def _author_ids(direct_db, media_id):
    return [c["contributor_id"] for c in _credits(direct_db, media_id) if c["role"] == "author"]


def _single_author_id(direct_db, media_id):
    ids = _author_ids(direct_db, media_id)
    assert len(ids) == 1, f"expected one author credit, got {ids}"
    return ids[0]


def _handle_of(direct_db, contributor_id):
    with direct_db.session() as session:
        return session.execute(
            text("SELECT handle FROM contributors WHERE id = :i"), {"i": contributor_id}
        ).scalar_one()


def _display_of(direct_db, contributor_id):
    with direct_db.session() as session:
        return session.execute(
            text("SELECT display_name FROM contributors WHERE id = :i"), {"i": contributor_id}
        ).scalar_one()


def _contributor_exists(direct_db, contributor_id):
    with direct_db.session() as session:
        return (
            session.execute(
                text("SELECT 1 FROM contributors WHERE id = :i"), {"i": contributor_id}
            ).first()
            is not None
        )


def _manual_row_new(name, display=None):
    return {"creditedName": name, "binding": {"kind": "new", "displayName": display or name}}


def _manual_row_existing(name, handle):
    return {"creditedName": name, "binding": {"kind": "existing", "contributorHandle": handle}}


def _manual_request(client_mutation_id, rows):
    return ManualMediaAuthorsRequest.model_validate(
        {"clientMutationId": client_mutation_id, "mode": "manual", "authors": rows}
    )


def _automatic_request(client_mutation_id):
    return AutomaticMediaAuthorsRequest.model_validate(
        {"clientMutationId": client_mutation_id, "mode": "automatic"}
    )


def _rename_request(client_mutation_id, display_name):
    return ContributorRenameRequest.model_validate(
        {"clientMutationId": client_mutation_id, "displayName": display_name}
    )


def _put_manual(direct_db, viewer, media_id, rows, *, client_mutation_id=None):
    out = contributors.put_media_authors(
        viewer=viewer,
        media_id=media_id,
        request=_manual_request(client_mutation_id or f"cmid-{uuid4()}", rows),
    )
    _track_media_contributors(direct_db, media_id)
    return out


def _fullwidth(value):
    return "".join(chr(ord(ch) + 0xFEE0) if 0x21 <= ord(ch) <= 0x7E else ch for ch in value)


@contextmanager
def _captured_statements():
    """Capture every SQL statement the author facade's engine executes."""
    engine = get_engine()
    statements: list[str] = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _listener)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _listener)


class _FakeSerializationError(Exception):
    # Shape recognised by nexus.db.errors.is_serialization_failure.
    sqlstate = "40001"

    def __str__(self):
        return "could not serialize access due to read/write dependencies among transactions"


@contextmanager
def _fail_once_on_credit_insert():
    """Force one serialization-style failure on the first contributor_credits INSERT.

    A one-shot ``before_cursor_execute`` listener on the facade's engine raises the
    first time a credit row is inserted, then disarms. ``retry_serializable`` rolls
    back and re-runs the whole operation, exercising the retry path deterministically
    without a second connection.
    """
    from sqlalchemy.exc import OperationalError

    engine = get_engine()
    state = {"armed": True}

    def _listener(conn, cursor, statement, parameters, context, executemany):
        if state["armed"] and statement.lstrip().upper().startswith(
            "INSERT INTO CONTRIBUTOR_CREDITS"
        ):
            state["armed"] = False
            raise OperationalError("forced retry", None, _FakeSerializationError())

    event.listen(engine, "before_cursor_execute", _listener)
    try:
        yield state
    finally:
        event.remove(engine, "before_cursor_execute", _listener)


# ===========================================================================
# Resolver — AC 1-7
# ===========================================================================


def test_two_adapters_with_same_name_create_one_contributor(direct_db):
    """AC 1: two lanes observing the same normalized name credit one contributor."""
    viewer = _bootstrap_viewer(direct_db)
    name = f"Jane Author {uuid4().hex[:8]}"
    media_a = _seed_media(direct_db, viewer)
    media_b = _seed_media(direct_db, viewer)

    _observe(direct_db, media_a, _author_obs(name), source="epub_opf")
    _observe(direct_db, media_b, _author_obs(name), source="pdf_metadata")

    assert _single_author_id(direct_db, media_a) == _single_author_id(direct_db, media_b)


def test_unicode_variants_reuse_and_punctuation_diacritics_stay_distinct(direct_db):
    """AC 2: default-ignorable/case/compat variants reuse; punctuation/order/diacritics do not."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    base = f"Jane Smith {token}"
    media_base = _seed_media(direct_db, viewer)
    _observe(direct_db, media_base, _author_obs(base))
    base_id = _single_author_id(direct_db, media_base)

    reuse_variants = {
        "case": base.upper(),
        "fullwidth": _fullwidth(base),
        "soft_hyphen": f"Jane Smi­th {token}",
        "zwsp": f"Ja​ne Smith {token}",
        "bom": "﻿" + base,
    }
    for label, variant in reuse_variants.items():
        media = _seed_media(direct_db, viewer)
        _observe(direct_db, media, _author_obs(variant))
        assert _single_author_id(direct_db, media) == base_id, f"{label!r} should reuse the base"

    distinct_variants = {
        "hyphen": f"Jane-Smith {token}",
        "order": f"Smith Jane {token}",
        "diacritic": f"Jané Smith {token}",
    }
    distinct_ids = set()
    for label, variant in distinct_variants.items():
        media = _seed_media(direct_db, viewer)
        _observe(direct_db, media, _author_obs(variant))
        variant_id = _single_author_id(direct_db, media)
        assert variant_id != base_id, f"{label!r} must not merge into the base"
        distinct_ids.add(variant_id)
    assert len(distinct_ids) == len(distinct_variants), "each distinct variant is its own identity"


def test_resolving_aliases_bind_and_non_resolving_alias_does_not(direct_db):
    """AC 3/4: canonical + rename aliases resolve; a provider-observed spelling does not."""
    viewer = _bootstrap_viewer(direct_db, roles=["contributor_curator"])
    token = uuid4().hex[:8]
    old_name = f"Robert Jones {token}"
    new_name = f"Bobby Jones {token}"

    media_a = _seed_media(direct_db, viewer)
    _observe(direct_db, media_a, _author_obs(old_name))
    robert_id = _single_author_id(direct_db, media_a)
    handle = parse_contributor_handle(_handle_of(direct_db, robert_id))

    contributors.ensure_contributor_display_name(
        viewer=viewer,
        contributor_handle=handle,
        request=_rename_request(f"cmid-{uuid4()}", new_name),
    )

    # The old canonical spelling and the new display both resolve to the same person.
    media_old = _seed_media(direct_db, viewer)
    _observe(direct_db, media_old, _author_obs(old_name))
    assert _single_author_id(direct_db, media_old) == robert_id
    media_new = _seed_media(direct_db, viewer)
    _observe(direct_db, media_new, _author_obs(new_name))
    assert _single_author_id(direct_db, media_new) == robert_id

    # A spelling introduced only through an exact key becomes a searchable but
    # non-resolving alias; observing it name-only later must NOT bind to that person.
    key = _openalex_key()
    keyed_name = f"Alan Turing {token}"
    variant_name = f"A M Turing {token}"
    media_keyed = _seed_media(direct_db, viewer)
    _observe(direct_db, media_keyed, _author_obs((keyed_name, key)))
    turing_id = _single_author_id(direct_db, media_keyed)
    media_variant_keyed = _seed_media(direct_db, viewer)
    _observe(direct_db, media_variant_keyed, _author_obs((variant_name, key)))
    # AC 4: the exact key wins across the display change without renaming the person.
    assert _single_author_id(direct_db, media_variant_keyed) == turing_id
    assert _display_of(direct_db, turing_id) == keyed_name

    media_variant_nameonly = _seed_media(direct_db, viewer)
    _observe(direct_db, media_variant_nameonly, _author_obs(variant_name))
    assert _single_author_id(direct_db, media_variant_nameonly) != turing_id


def test_same_authority_key_contradiction_forces_distinct(direct_db):
    """AC 5: a same-authority key conflict on the name winner forces a distinct identity."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    name = f"John Doe {token}"

    media_a = _seed_media(direct_db, viewer)
    _observe(direct_db, media_a, _author_obs((name, _openalex_key())))
    media_b = _seed_media(direct_db, viewer)
    _observe(direct_db, media_b, _author_obs((name, _openalex_key())))  # different openalex key
    assert _single_author_id(direct_db, media_a) != _single_author_id(direct_db, media_b)


def test_different_authorities_do_not_force_distinct(direct_db):
    """AC 5: keys under different authorities are never inferred to be a conflict."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    name = f"Jane Roe {token}"

    media_a = _seed_media(direct_db, viewer)
    _observe(direct_db, media_a, _author_obs((name, _openalex_key())))
    media_b = _seed_media(direct_db, viewer)
    _observe(direct_db, media_b, _author_obs((name, _key("wikidata", f"Q{uuid4().hex}"))))
    assert _single_author_id(direct_db, media_a) == _single_author_id(direct_db, media_b)


def test_earliest_created_winner_is_stable_as_credit_counts_grow(direct_db):
    """AC 6: multiple same-name identities always resolve to the earliest-created one."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    name = f"Sam Rivers {token}"

    media_first = _seed_media(direct_db, viewer)
    _observe(direct_db, media_first, _author_obs(name))
    first_id = _single_author_id(direct_db, media_first)

    # A deliberate same-name second identity via the manual "different author" path.
    media_second = _seed_media(direct_db, viewer)
    second_out = _put_manual(direct_db, viewer, media_second, [_manual_row_new(name)])
    second_handle = second_out.authors[0].contributor_handle
    second_id = _single_author_id(direct_db, media_second)
    assert second_id != first_id

    # Grow the second identity's work count past the first's.
    media_grow = _seed_media(direct_db, viewer)
    _put_manual(direct_db, viewer, media_grow, [_manual_row_existing(name, second_handle)])

    with direct_db.session() as session:
        first_created, second_created = (
            session.execute(
                text("SELECT created_at FROM contributors WHERE id = :i"), {"i": cid}
            ).scalar_one()
            for cid in (first_id, second_id)
        )
    assert first_created < second_created, "premise: the first identity was created earliest"

    # A fresh automatic observation still resolves to the earliest identity.
    media_new = _seed_media(direct_db, viewer)
    _observe(direct_db, media_new, _author_obs(name))
    assert _single_author_id(direct_db, media_new) == first_id


def test_same_batch_groups_equal_names_and_keys_and_keeps_source_order(direct_db):
    """AC 7: within one batch equal names/keys group, contradictions stay distinct, order holds."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    grace = f"Grace Hopper {token}"
    ada = f"Ada Byron {token}"
    ada_key_a = _openalex_key()
    ada_key_b = _openalex_key()

    media = _seed_media(direct_db, viewer)
    _observe(
        direct_db,
        media,
        _author_obs(
            grace,  # position 0
            (ada, ada_key_a),  # position 1
            grace,  # position 2 — duplicate name of #0, grouped away
            (ada, ada_key_b),  # position 3 — same name, contradicting key -> distinct
        ),
    )

    rows = _credits(direct_db, media)
    assert [r["credited_name"] for r in rows] == [grace, ada, ada], "grouping + source order"
    ids = [r["contributor_id"] for r in rows]
    assert len(set(ids)) == 3, "one Grace identity, two contradicting Ada identities"


# ===========================================================================
# Role-slice replacement — AC 10, 11, 13, 15, 16
# ===========================================================================


def test_not_observed_preserves_prior_credits(direct_db):
    """AC 10: a not_observed attempt never erases a prior managed slice."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    _observe(direct_db, media, _author_obs(f"Keeper {uuid4().hex[:8]}"))
    before = _credits(direct_db, media)

    contributors.replace_observed_role_slices(
        target=contributors.MediaTarget(media),
        observation=NOT_OBSERVED,
        source="metadata_enrichment",
    )
    assert _credits(direct_db, media) == before


def test_replacement_touches_only_declared_roles(direct_db):
    """AC 11: a lane replaces only its declared role slices; undeclared roles survive."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    media = _seed_media(direct_db, viewer)
    _observe(
        direct_db,
        media,
        _obs((f"Auth One {token}", "author", None), (f"Ed One {token}", "editor", None)),
    )
    assert _names_for_role(direct_db, media, "author") == [f"Auth One {token}"]
    assert _names_for_role(direct_db, media, "editor") == [f"Ed One {token}"]

    # Author-only observation: the editor slice is undeclared and must survive.
    _observe(direct_db, media, _author_obs(f"Auth Two {token}"))
    assert _names_for_role(direct_db, media, "author") == [f"Auth Two {token}"]
    assert _names_for_role(direct_db, media, "editor") == [f"Ed One {token}"]


def test_manual_pin_blocks_author_lane_but_not_declared_non_author_lane(direct_db):
    """AC 13: a manual author pin freezes only the author slice."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    media = _seed_media(direct_db, viewer)
    _observe(
        direct_db,
        media,
        _obs((f"Auto Author {token}", "author", None), (f"Auto Editor {token}", "editor", None)),
    )

    _put_manual(direct_db, viewer, media, [_manual_row_new(f"Pinned Author {token}")])
    assert _names_for_role(direct_db, media, "author") == [f"Pinned Author {token}"]
    assert _names_for_role(direct_db, media, "editor") == [f"Auto Editor {token}"]

    # A later automatic lane declaring both: author is pinned, editor still replaces.
    _observe(
        direct_db,
        media,
        _obs(
            (f"Ignored Author {token}", "author", None), (f"Fresh Editor {token}", "editor", None)
        ),
    )
    assert _names_for_role(direct_db, media, "author") == [f"Pinned Author {token}"]
    assert _names_for_role(direct_db, media, "editor") == [f"Fresh Editor {token}"]


def test_reset_keeps_rows_and_next_observation_replaces(direct_db):
    """AC 15: reset flips mode to automatic without erasing rows; the next observation replaces."""
    viewer = _bootstrap_viewer(direct_db)
    token = uuid4().hex[:8]
    media = _seed_media(direct_db, viewer)
    _put_manual(direct_db, viewer, media, [_manual_row_new(f"Manual One {token}")])

    reset = contributors.put_media_authors(
        viewer=viewer, media_id=media, request=_automatic_request(f"cmid-{uuid4()}")
    )
    assert reset.author_mode == "automatic"
    assert [a.credited_name for a in reset.authors] == [f"Manual One {token}"]
    assert _names_for_role(direct_db, media, "author") == [f"Manual One {token}"]

    _observe(direct_db, media, _author_obs(f"Auto Replacement {token}"))
    assert _names_for_role(direct_db, media, "author") == [f"Auto Replacement {token}"]


def test_unchanged_replacement_performs_no_dml(direct_db):
    """AC 16: an unchanged observation is zero-DML — no credit row is written or touched."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    name = f"Stable Author {uuid4().hex[:8]}"
    _observe(direct_db, media, _author_obs(name), source="epub_opf")

    with direct_db.session() as session:
        before = session.execute(
            text("SELECT id, updated_at FROM contributor_credits WHERE media_id = :m"),
            {"m": media},
        ).one()

    with _captured_statements() as statements:
        _observe(direct_db, media, _author_obs(name), source="epub_opf")

    credit_dml = [
        s
        for s in statements
        if "CONTRIBUTOR_CREDITS" in " ".join(s.split()).upper()
        and " ".join(s.split()).upper().startswith(("INSERT", "UPDATE", "DELETE"))
    ]
    assert credit_dml == [], f"unchanged replacement wrote credit DML: {credit_dml}"

    with direct_db.session() as session:
        after = session.execute(
            text("SELECT id, updated_at FROM contributor_credits WHERE media_id = :m"),
            {"m": media},
        ).one()
    assert (after.id, after.updated_at) == (before.id, before.updated_at)


# ===========================================================================
# Replay + cleanup — AC 17, 19
# ===========================================================================


def test_manual_put_replays_exact_response_after_later_edit_and_409s_on_mismatch(direct_db):
    """AC 17: replaying a forced-new edit returns its exact memo and 409s on mismatch."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    token = uuid4().hex[:8]
    cmid = f"cmid-{uuid4()}"

    first = _put_manual(
        direct_db,
        viewer,
        media,
        [_manual_row_new(f"Replay Author {token}")],
        client_mutation_id=cmid,
    )

    # A different key changes the list.
    _put_manual(direct_db, viewer, media, [_manual_row_new(f"Later Author {token}")])
    assert _names_for_role(direct_db, media, "author") == [f"Later Author {token}"]

    # Exact replay of the first key returns the recorded response and does not revert.
    replay = _put_manual(
        direct_db,
        viewer,
        media,
        [_manual_row_new(f"Replay Author {token}")],
        client_mutation_id=cmid,
    )
    assert replay == first
    assert _names_for_role(direct_db, media, "author") == [f"Later Author {token}"]

    # Same key, different payload -> 409 replay mismatch.
    with pytest.raises(ConflictError) as excinfo:
        _put_manual(
            direct_db,
            viewer,
            media,
            [_manual_row_new(f"Different {token}")],
            client_mutation_id=cmid,
        )
    assert excinfo.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH


def test_target_cleanup_prunes_orphan_and_recreation_reuses_handle(direct_db):
    """AC 19: deleting a target removes credits/memos, prunes the orphan, and recreation reuses the handle."""
    viewer = _bootstrap_viewer(direct_db)
    name = f"Ephemeral Author {uuid4().hex[:8]}"
    media_a = _seed_media(direct_db, viewer)
    _observe(direct_db, media_a, _author_obs(name))
    contributor_id = _single_author_id(direct_db, media_a)
    original_handle = _handle_of(direct_db, contributor_id)

    with direct_db.session() as session:
        contributors.cleanup_credits_for_deleted_target(
            session, target=contributors.MediaTarget(media_a)
        )
        session.commit()

    assert _credits(direct_db, media_a) == []
    assert not _contributor_exists(direct_db, contributor_id), "zero-work orphan should be pruned"

    # Recreating the same name derives the same deterministic base handle -> same URL.
    media_b = _seed_media(direct_db, viewer)
    _observe(direct_db, media_b, _author_obs(name))
    recreated_id = _single_author_id(direct_db, media_b)
    assert recreated_id != contributor_id
    assert _handle_of(direct_db, recreated_id) == original_handle


# ===========================================================================
# Rename replay — AC 22
# ===========================================================================


def test_rename_replay_returns_recorded_response_without_reverting_later_rename(direct_db):
    """AC 22: A->B lost, B->C later, replay A->B returns the recorded response, C stands."""
    viewer = _bootstrap_viewer(direct_db, roles=["contributor_curator"])
    token = uuid4().hex[:8]
    media = _seed_media(direct_db, viewer)
    _observe(direct_db, media, _author_obs(f"Name A {token}"))
    contributor_id = _single_author_id(direct_db, media)
    handle = parse_contributor_handle(_handle_of(direct_db, contributor_id))
    cmid_ab = f"cmid-{uuid4()}"

    to_b = contributors.ensure_contributor_display_name(
        viewer=viewer,
        contributor_handle=handle,
        request=_rename_request(cmid_ab, f"Name B {token}"),
    )
    contributors.ensure_contributor_display_name(
        viewer=viewer,
        contributor_handle=handle,
        request=_rename_request(f"cmid-{uuid4()}", f"Name C {token}"),
    )

    replay = contributors.ensure_contributor_display_name(
        viewer=viewer,
        contributor_handle=handle,
        request=_rename_request(cmid_ab, f"Name B {token}"),
    )
    assert replay == to_b
    assert replay.display_name == f"Name B {token}"
    # The replay did not revert the intervening C rename.
    assert _display_of(direct_db, contributor_id) == f"Name C {token}"


# ===========================================================================
# Named plan tests — D-41, D-42, D-43, D-44
# ===========================================================================


def test_automatic_lane_writes_no_resource_mutations_even_across_a_forced_retry(direct_db):
    """D-43: the automatic lane never memoizes, even when the whole op retries."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    name = f"Retry Author {uuid4().hex[:8]}"
    scope = f"media:{media}:authors"

    def _memo_count():
        with direct_db.session() as session:
            return session.execute(
                text("SELECT count(*) FROM resource_mutations WHERE mutation_scope = :s"),
                {"s": scope},
            ).scalar_one()

    assert _memo_count() == 0

    with _fail_once_on_credit_insert() as state:
        _observe(direct_db, media, _author_obs(name))
    assert state["armed"] is False, "the injected failure never fired: retry path not exercised"

    # The retry converged and wrote the credit, but never a replay memo.
    assert _names_for_role(direct_db, media, "author") == [name]
    assert _memo_count() == 0


def test_replay_revalidates_stored_memo_and_defects_on_corruption(direct_db):
    """D-42: a corrupt stored memo is a defect on replay, never returned raw."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    cmid = f"cmid-{uuid4()}"
    request = _manual_request(cmid, [_manual_row_new(f"Corruptible {uuid4().hex[:8]}")])
    contributors.put_media_authors(viewer=viewer, media_id=media, request=request)
    _track_media_contributors(direct_db, media)

    with direct_db.session() as session:
        session.execute(
            update(ResourceMutation)
            .where(ResourceMutation.mutation_scope == f"media:{media}:authors")
            .values(response_json={"unexpected": "shape"})
        )
        session.commit()

    with pytest.raises(AssertionError):
        contributors.put_media_authors(viewer=viewer, media_id=media, request=request)


def test_rename_authorizes_before_replay_lookup(direct_db):
    """D-44: an unauthorized viewer replaying an existing memo key gets 403, never the memo."""
    curator = _bootstrap_viewer(direct_db, roles=["contributor_curator"])
    media = _seed_media(direct_db, curator)
    _observe(direct_db, media, _author_obs(f"Auth First {uuid4().hex[:8]}"))
    handle = parse_contributor_handle(_handle_of(direct_db, _single_author_id(direct_db, media)))
    cmid = f"cmid-{uuid4()}"

    contributors.ensure_contributor_display_name(
        viewer=curator, contributor_handle=handle, request=_rename_request(cmid, "Curated Rename")
    )

    # Same user, but now without the curator role: sees the contributor, cannot rename.
    plain = Viewer(user_id=curator.user_id, default_library_id=curator.default_library_id)
    with pytest.raises(ForbiddenError) as excinfo:
        contributors.ensure_contributor_display_name(
            viewer=plain, contributor_handle=handle, request=_rename_request(cmid, "Curated Rename")
        )
    assert excinfo.value.code == ApiErrorCode.E_FORBIDDEN


def test_note_body_referenced_orphan_is_not_pruned(direct_db):
    """D-41: a zero-credit contributor referenced by a note-body edge is not pruned."""
    viewer = _bootstrap_viewer(direct_db)
    contributor_id = uuid4()
    name = f"Noted Person {uuid4().hex[:8]}"
    _track_contributor(direct_db, contributor_id)
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO contributors (id, handle, display_name) "
                "VALUES (:id, :handle, :display_name)"
            ),
            {"id": contributor_id, "handle": f"noted-{uuid4().hex[:12]}", "display_name": name},
        )
        session.add(
            ResourceEdge(
                user_id=viewer.user_id,
                kind="context",
                origin="note_body",
                source_scheme="note_block",
                source_id=uuid4(),
                target_scheme="contributor",
                target_id=contributor_id,
            )
        )
        session.commit()

    with direct_db.session() as session:
        contributors.prune_contributors_if_orphaned(session, contributor_ids=[contributor_id])
        session.commit()

    assert _contributor_exists(direct_db, contributor_id), "note-body reference must block pruning"


def test_keyed_zero_work_contributor_is_not_pruned_and_is_hidden_from_search(direct_db):
    """D-41 / AC 19: a keyed zero-work identity survives pruning but is undiscoverable."""
    viewer = _bootstrap_viewer(direct_db)
    contributor_id = uuid4()
    name = f"Keyed No Works {uuid4().hex[:8]}"
    _track_contributor(direct_db, contributor_id)
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO contributors (id, handle, display_name) "
                "VALUES (:id, :handle, :display_name)"
            ),
            {"id": contributor_id, "handle": f"keyed-{uuid4().hex[:12]}", "display_name": name},
        )
        session.execute(
            text(
                "INSERT INTO contributor_aliases "
                "(id, contributor_id, alias, normalized_alias, resolves_identity) "
                "VALUES (:id, :cid, :alias, :normalized, true)"
            ),
            {
                "id": uuid4(),
                "cid": contributor_id,
                "alias": name,
                "normalized": contributor_match_key(name),
            },
        )
        session.execute(
            text(
                "INSERT INTO contributor_external_ids (id, contributor_id, authority, external_key) "
                "VALUES (:id, :cid, 'openalex', :key)"
            ),
            {"id": uuid4(), "cid": contributor_id, "key": f"W{uuid4().hex}"},
        )
        session.commit()

    with direct_db.session() as session:
        contributors.prune_contributors_if_orphaned(session, contributor_ids=[contributor_id])
        session.commit()
    assert _contributor_exists(direct_db, contributor_id), "an exact key blocks pruning"

    with direct_db.session() as session:
        page = contributors.search_contributors(session, viewer_id=viewer.user_id, q=name)
    handles = {item.handle for item in page.contributors}
    assert _handle_of(direct_db, contributor_id) not in handles, (
        "zero-work key owner must be hidden"
    )


def test_manual_author_dropped_by_later_put_is_memo_protected_until_target_cleanup(direct_db):
    """Spec 2.8: a replay-protected manual identity survives while its owning media
    memo exists, and target cleanup prunes it once the memos are removed."""
    viewer = _bootstrap_viewer(direct_db)
    media = _seed_media(direct_db, viewer)
    name = f"Memo Kept {uuid4().hex[:8]}"

    first = _put_manual(direct_db, viewer, media, [_manual_row_new(name)])
    kept_id = _single_author_id(direct_db, media)
    _track_contributor(direct_db, kept_id)

    # A second PUT drops the author; the first PUT's committed memo still names it.
    _put_manual(direct_db, viewer, media, [])
    assert _names_for_role(direct_db, media, "author") == []
    assert _contributor_exists(direct_db, kept_id), (
        "a contributor named by a committed media-author memo must not be pruned"
    )
    # The recorded response still resolves: its handle does not dangle.
    assert first.authors[0].contributor_handle == _handle_of(direct_db, kept_id)

    # Target deletion removes the media's author-edit memos FIRST, then prunes the
    # identities those memos were keeping alive.
    with direct_db.session() as session:
        contributors.cleanup_credits_for_deleted_target(
            session, target=contributors.MediaTarget(media)
        )
        session.commit()

    with direct_db.session() as session:
        remaining_memos = session.execute(
            text("SELECT count(*) FROM resource_mutations WHERE mutation_scope = :s"),
            {"s": f"media:{media}:authors"},
        ).scalar_one()
    assert remaining_memos == 0, "target cleanup removes the media's author-edit memos"
    assert not _contributor_exists(direct_db, kept_id), (
        "once its owning memos are gone the zero-work identity is pruned"
    )


def test_batch_chunk_prunes_then_recreates_same_name_within_one_transaction(direct_db):
    """D-15/spec 2.8: one batch chunk may drop a name's last credit on one target and
    re-observe that name on another; the recreate must reuse the freed base handle."""
    viewer = _bootstrap_viewer(direct_db)
    name = f"Moved Author {uuid4().hex[:8]}"
    other = f"Replacement Author {uuid4().hex[:8]}"
    media_a = _seed_media(direct_db, viewer)
    media_b = _seed_media(direct_db, viewer)

    _observe(direct_db, media_a, _author_obs(name))
    original_id = _single_author_id(direct_db, media_a)
    original_handle = _handle_of(direct_db, original_id)

    # One chunk transaction: target A drops the name (orphan -> pruned in-op),
    # target B re-observes it. The prune must be visible to B's resolution or the
    # deterministic handle ladder is exhausted mid-chunk.
    contributors.replace_observed_role_slices_batch(
        [
            (contributors.MediaTarget(media_a), _author_obs(other), "project_gutenberg_catalog"),
            (contributors.MediaTarget(media_b), _author_obs(name), "project_gutenberg_catalog"),
        ]
    )
    _track_media_contributors(direct_db, media_a)
    _track_media_contributors(direct_db, media_b)

    assert _names_for_role(direct_db, media_a, "author") == [other]
    assert _names_for_role(direct_db, media_b, "author") == [name]
    assert not _contributor_exists(direct_db, original_id), "orphaned identity is pruned in-op"
    recreated_id = _single_author_id(direct_db, media_b)
    assert recreated_id != original_id
    assert _handle_of(direct_db, recreated_id) == original_handle, (
        "recreating an ordinary pruned same-name identity reuses its handle/URL"
    )


def test_rename_to_case_variant_of_same_name_stays_searchable(direct_db):
    """Spec 2.6/§4: a same-match-key rename (case variant) keeps the display alias
    literal aligned, so picker search still finds the contributor."""
    curator = _bootstrap_viewer(direct_db, roles=["contributor_curator"])
    media = _seed_media(direct_db, curator)
    name = f"Casey Mcvariant {uuid4().hex[:8]}"
    _observe(direct_db, media, _author_obs(name))
    contributor_id = _single_author_id(direct_db, media)
    handle = parse_contributor_handle(_handle_of(direct_db, contributor_id))

    upper = name.upper()  # same match key, different literal
    assert contributor_match_key(upper) == contributor_match_key(name)
    detail = contributors.ensure_contributor_display_name(
        viewer=curator,
        contributor_handle=handle,
        request=_rename_request(f"cmid-{uuid4()}", upper),
    )
    assert detail.display_name == upper
    assert _display_of(direct_db, contributor_id) == upper

    with direct_db.session() as session:
        page = contributors.search_contributors(session, viewer_id=curator.user_id, q=name)
    assert [item.display_name for item in page.contributors] == [upper], (
        "a case-variant rename must not drop the contributor from picker search"
    )
