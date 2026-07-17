"""Scope × entity matrix coverage (search cutover §4.6 / AC-12).

One assertion per matrix cell: every supported cell returns a scoped SQL fragment
keyed to the entity's column; every unsupported cell returns the UNSUPPORTED sentinel;
`all` is always the unscoped empty clause. Pins the centralized scope owner so a future
edit cannot silently change a cell's behavior.
"""

from uuid import uuid4

import pytest

from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.search.scope import (
    _SCOPE_MATRIX,
    UNSUPPORTED,
    ScopeUnsupported,
    scope_filter_sql,
)

pytestmark = pytest.mark.unit

# Enumerated from the code-owned matrix itself (not hand-copied) so a future entity
# added to `_SCOPE_MATRIX` is automatically covered by every test below instead of
# silently falling out of coverage the way `reader_apparatus_item` previously did.
ENTITIES = sorted(_SCOPE_MATRIX)

# The full 13-entity matrix this cutover's blast radius is scoped to (§7). A change
# to this set is itself a signal the matrix grew/shrank and needs a deliberate look,
# not just a passive `ENTITIES` follow-along.
EXPECTED_ENTITIES = {
    "media",
    "podcast",
    "content_chunk",
    "fragment",
    "evidence_span",
    "reader_apparatus_item",
    "page",
    "note_block",
    "highlight",
    "message",
    "conversation",
    "web_result",
    "contributor",
}


def test_scope_matrix_has_exactly_the_thirteen_code_owned_entities() -> None:
    assert set(_SCOPE_MATRIX) == EXPECTED_ENTITIES
    assert len(_SCOPE_MATRIX) == 13


# (entity, scope_type) cells that yield no results.
UNSUPPORTED_CELLS = {
    ("podcast", "media"),
    ("fragment", "conversation"),
    ("message", "media"),
    ("conversation", "media"),
    ("web_result", "media"),
}

# The column each entity's media-scope fragment must reference (spot-check the cell SQL).
MEDIA_SCOPE_COLUMN = {
    "media": "m.id = :scope_id",
    "content_chunk": "cc.owner_kind = 'media' AND cc.owner_id = :scope_id",
    "fragment": "f.media_id = :scope_id",
    "evidence_span": "es.owner_kind = 'media' AND es.owner_id = :scope_id",
    "reader_apparatus_item": "rai.media_id = :scope_id",
    "highlight": "h.anchor_media_id = :scope_id",
    "contributor": "cc.media_id = :scope_id",
}

# The page/note_block media/library cells are resource_edges EXISTS subqueries keyed
# on (scheme, object_id_sql) via `_note_object_scope`, matching edges at either
# endpoint (provenance graph §11.9). Spot-check that each cell wires the right
# scheme/object-id into the edge-match predicate.
NOTE_OBJECT_EDGE_MATCH = {
    "page": (
        "(e.source_scheme = 'page' AND e.source_id = p.id) "
        "OR (e.target_scheme = 'page' AND e.target_id = p.id)"
    ),
    "note_block": (
        "(e.source_scheme = 'note_block' AND e.source_id = cc.owner_id) "
        "OR (e.target_scheme = 'note_block' AND e.target_id = cc.owner_id)"
    ),
}

# The conversation cells match bare conversation context edges from the conversation
# to the object. Citation/containment rows must not make notes searchable inside an
# unrelated chat scope. Compared whitespace-squashed so SQL reformatting cannot
# break the pin.
NOTE_OBJECT_CONTEXT_TARGET = {
    "page": "AND e.target_scheme = 'page' AND e.target_id = p.id",
    "note_block": ("AND e.target_scheme = 'note_block' AND e.target_id = cc.owner_id"),
}


def _squash(sql: str) -> str:
    return " ".join(sql.split())


def test_all_scope_is_unscoped_for_every_entity() -> None:
    for entity in ENTITIES:
        result = scope_filter_sql("all", None, entity)
        assert result == ("", {}), entity


@pytest.mark.parametrize("entity", ENTITIES)
@pytest.mark.parametrize("scope_type", ["media", "library", "conversation"])
def test_every_cell_is_either_unsupported_or_a_scoped_fragment(
    entity: str, scope_type: str
) -> None:
    scope_id = uuid4()
    result = scope_filter_sql(scope_type, scope_id, entity)
    if (entity, scope_type) in UNSUPPORTED_CELLS:
        assert isinstance(result, ScopeUnsupported)
        assert result is UNSUPPORTED
        return
    assert not isinstance(result, ScopeUnsupported), (
        f"{entity}/{scope_type} unexpectedly UNSUPPORTED"
    )
    sql, params = result
    assert sql.strip().startswith("AND"), f"{entity}/{scope_type}: {sql!r}"
    assert params == {"scope_id": scope_id}


@pytest.mark.parametrize("entity,fragment", MEDIA_SCOPE_COLUMN.items())
def test_media_scope_targets_the_entity_column(entity: str, fragment: str) -> None:
    result = scope_filter_sql("media", uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    assert fragment in result[0]


@pytest.mark.parametrize("entity,edge_match", NOTE_OBJECT_EDGE_MATCH.items())
@pytest.mark.parametrize("scope_type", ["media", "library"])
def test_note_object_membership_cells_are_resource_edge_exists(
    entity: str, edge_match: str, scope_type: str
) -> None:
    # page/note_block media/library scope by a resource_edges EXISTS subquery keyed
    # on the object's (scheme, id), matched at either endpoint.
    result = scope_filter_sql(scope_type, uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "EXISTS ( SELECT 1 FROM resource_edges e" in sql
    assert _squash(edge_match) in sql


@pytest.mark.parametrize("entity", ["page", "note_block"])
@pytest.mark.parametrize("scope_type", ["media", "library"])
def test_note_object_membership_cells_admit_only_note_media_edge_origins(
    entity: str, scope_type: str
) -> None:
    # Machine-proposed (synapse) edges must not silently change scoped
    # retrieval; admission requires the explicit note-media edge allowlist. The
    # conversation cells use a separate conversation-context allowlist pinned below.
    result = scope_filter_sql(scope_type, uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "e.kind = 'context'" in sql
    assert "e.origin IN ('user', 'highlight_note')" in sql
    assert "e.ordinal IS NULL" in sql
    assert "note_containment" not in sql
    assert "synapse" not in sql


@pytest.mark.parametrize("entity,target_match", NOTE_OBJECT_CONTEXT_TARGET.items())
def test_note_object_conversation_cells_match_context_edges(entity: str, target_match: str) -> None:
    result = scope_filter_sql("conversation", uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "EXISTS ( SELECT 1 FROM resource_edges e" in sql
    assert "e.source_scheme = 'conversation' AND e.source_id = :scope_id" in sql
    assert target_match in sql
    assert "e.kind = 'context'" in sql
    assert "e.origin IN ('user', 'citation', 'system')" in sql
    assert "e.ordinal IS NULL" in sql


def test_highlight_conversation_cell_matches_context_edges() -> None:
    # The highlight conversation cell uses the same context-edge admission.
    result = scope_filter_sql("conversation", uuid4(), "highlight")
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "e.source_scheme = 'conversation' AND e.source_id = :scope_id" in sql
    assert "e.target_scheme = 'highlight' AND e.target_id = h.id" in sql
    assert "e.kind = 'context'" in sql
    assert "e.origin IN ('user', 'citation', 'system')" in sql
    assert "e.ordinal IS NULL" in sql


@pytest.mark.parametrize(
    "entity",
    ["media", "podcast", "content_chunk", "evidence_span", "contributor"],
)
def test_media_backed_conversation_cells_use_context_edges(entity: str) -> None:
    result = scope_filter_sql("conversation", uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "conversation_media" not in sql
    assert "resource_edges e" in sql
    assert "e.source_scheme = 'conversation'" in sql
    assert "e.source_id = :scope_id" in sql
    assert "e.target_scheme = 'media'" in sql
    assert "e.kind = 'context'" in sql
    assert "e.origin IN ('user', 'citation', 'system')" in sql
    assert "e.ordinal IS NULL" in sql


def test_share_semantics_cells_use_conversation_shares() -> None:
    # message / web_result library scope filters on actively-shared conversations.
    for entity in ("message", "web_result"):
        result = scope_filter_sql("library", uuid4(), entity)
        assert not isinstance(result, ScopeUnsupported)
        assert "conversation_shares" in result[0]
        assert "conv.sharing = 'library'" in result[0]
    # plain conversation library scope omits the sharing-mode predicate (per current).
    conv = scope_filter_sql("library", uuid4(), "conversation")
    assert not isinstance(conv, ScopeUnsupported)
    assert "conversation_shares" in conv[0]
    assert "conv.sharing" not in conv[0]


# =============================================================================
# Library-cell delegation to the library-set owner (spec §4.1/§5).
#
# Media-derived cells (media, content_chunk, fragment, evidence_span,
# reader_apparatus_item, page, note_block, highlight) delegate their "library" scope
# to `library_entries.library_media_ids_cte_sql()` instead of reading raw
# `library_entries` containment directly. `contributor` delegates only its media
# branch — the podcast branch stays physical per §5 ("contributor scope composes
# virtual media plus physical podcasts"). `podcast`/`message`/`conversation`/
# `web_result` are untouched (podcast stays physical; the conversation-share trio
# keeps exact `conversation_shares` semantics — AC12: "do not widen").
#
# The partition below is asserted against `_SCOPE_MATRIX` itself (not just declared
# in prose) so this file cannot drift from the live matrix the way the old
# hand-copied `ENTITIES` list drifted (it silently omitted `reader_apparatus_item`).
# =============================================================================

DELEGATED_LIBRARY_ENTITIES = {
    "media",
    "content_chunk",
    "fragment",
    "evidence_span",
    "reader_apparatus_item",
    "page",
    "note_block",
    "highlight",
}
PARTIALLY_DELEGATED_LIBRARY_ENTITIES = {"contributor"}
UNCHANGED_LIBRARY_ENTITIES = {"podcast", "message", "conversation", "web_result"}

# The exact delegated relation, constructed the same way `scope.py` constructs it
# (rebinding the CTE's `:library_id` bind to `:scope_id` via `library_param`),
# squashed for a whitespace-insensitive substring check against the live matrix
# cell text. This proves actual delegation to the SUT rather than a hand-copied
# SQL string.
_LIBRARY_MEDIA_IDS_SQL_SQUASHED = _squash(library_media_ids_cte_sql(library_param=":scope_id"))

# The raw physical-containment shape every delegated cell used to emit before this
# cutover (`FROM library_entries WHERE library_id = :scope_id`, with or without a
# trailing `AND ..._id IS NOT NULL`) — must be gone from delegated cells.
_RAW_LIBRARY_CONTAINMENT_PATTERN = "FROM library_entries WHERE library_id = :scope_id"


def test_library_cell_partition_covers_the_whole_code_owned_matrix() -> None:
    assert (
        DELEGATED_LIBRARY_ENTITIES
        | PARTIALLY_DELEGATED_LIBRARY_ENTITIES
        | UNCHANGED_LIBRARY_ENTITIES
    ) == set(_SCOPE_MATRIX)


@pytest.mark.parametrize("entity", sorted(DELEGATED_LIBRARY_ENTITIES))
def test_library_cell_delegates_to_the_library_media_set_owner(entity: str) -> None:
    scope_id = uuid4()
    result = scope_filter_sql("library", scope_id, entity)
    assert not isinstance(result, ScopeUnsupported)
    sql, params = result
    assert params == {"scope_id": scope_id}
    squashed = _squash(sql)
    assert _LIBRARY_MEDIA_IDS_SQL_SQUASHED in squashed, (
        f"{entity}: library cell does not delegate to library_media_ids_cte_sql()"
    )
    assert _RAW_LIBRARY_CONTAINMENT_PATTERN not in squashed, (
        f"{entity}: library cell still reads raw library_entries containment SQL"
    )


def test_contributor_library_cell_composes_virtual_media_and_physical_podcast() -> None:
    scope_id = uuid4()
    result = scope_filter_sql("library", scope_id, "contributor")
    assert not isinstance(result, ScopeUnsupported)
    sql, params = result
    assert params == {"scope_id": scope_id}
    squashed = _squash(sql)
    assert _LIBRARY_MEDIA_IDS_SQL_SQUASHED in squashed
    assert (
        "cc.podcast_id IN ( SELECT podcast_id FROM library_entries "
        "WHERE library_id = :scope_id AND podcast_id IS NOT NULL )"
    ) in squashed


@pytest.mark.parametrize("entity", sorted(UNCHANGED_LIBRARY_ENTITIES))
def test_unchanged_library_cells_do_not_delegate(entity: str) -> None:
    # podcast stays physical (§4.1); message/conversation/web_result keep exact
    # conversation_shares semantics (§5) — neither reads the library-set owner.
    scope_id = uuid4()
    result = scope_filter_sql("library", scope_id, entity)
    assert not isinstance(result, ScopeUnsupported)
    squashed = _squash(result[0])
    assert _LIBRARY_MEDIA_IDS_SQL_SQUASHED not in squashed
