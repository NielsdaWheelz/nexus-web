"""Scope × entity matrix coverage (search cutover §4.6 / AC-12).

One assertion per matrix cell: every supported cell returns a scoped SQL fragment
keyed to the entity's column; every unsupported cell returns the UNSUPPORTED sentinel;
`all` is always the unscoped empty clause. Pins the centralized scope owner so a future
edit cannot silently change a cell's behavior.
"""

from uuid import uuid4

import pytest

from nexus.services.search.scope import UNSUPPORTED, ScopeUnsupported, scope_filter_sql

pytestmark = pytest.mark.unit

ENTITIES = [
    "media",
    "podcast",
    "content_chunk",
    "fragment",
    "evidence_span",
    "page",
    "note_block",
    "highlight",
    "message",
    "conversation",
    "web_result",
    "contributor",
]

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
        "(e.source_scheme = 'note_block'"
        " AND e.source_id = (cc.summary_locator->>'note_block_id')::uuid) "
        "OR (e.target_scheme = 'note_block'"
        " AND e.target_id = (cc.summary_locator->>'note_block_id')::uuid)"
    ),
}

# The conversation cells match conversation context edges: any kind/origin edge from
# the conversation to the object (`context.is_context_ref` semantics, graph §2.5).
# Compared whitespace-squashed so SQL reformatting cannot break the pin.
NOTE_OBJECT_CONTEXT_TARGET = {
    "page": "AND e.target_scheme = 'page' AND e.target_id = p.id",
    "note_block": (
        "AND e.target_scheme = 'note_block' "
        "AND e.target_id = (cc.summary_locator->>'note_block_id')::uuid"
    ),
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


@pytest.mark.parametrize("entity,target_match", NOTE_OBJECT_CONTEXT_TARGET.items())
def test_note_object_conversation_cells_match_context_edges(entity: str, target_match: str) -> None:
    # The conversation cell admits via a conversation context edge: source is the
    # conversation, target is the page/note_block, any kind/origin (graph §2.5).
    result = scope_filter_sql("conversation", uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "EXISTS ( SELECT 1 FROM resource_edges e" in sql
    assert "e.source_scheme = 'conversation' AND e.source_id = :scope_id" in sql
    assert target_match in sql
    assert "e.kind" not in sql and "e.origin" not in sql, (
        "context admission is any-kind/any-origin (is_context_ref semantics)"
    )


def test_highlight_conversation_cell_matches_context_edges() -> None:
    # The highlight conversation cell uses the same context-edge admission.
    result = scope_filter_sql("conversation", uuid4(), "highlight")
    assert not isinstance(result, ScopeUnsupported)
    sql = _squash(result[0])
    assert "e.source_scheme = 'conversation' AND e.source_id = :scope_id" in sql
    assert "e.target_scheme = 'highlight' AND e.target_id = h.id" in sql


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
