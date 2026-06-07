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

# The page/note_block cells are object_links EXISTS subqueries keyed on (object_type,
# object_id_sql) via `_note_object_scope`. Spot-check that each scope cell wires the
# right object_type/object-id into the link-match predicate (object_links shape).
NOTE_OBJECT_LINK_MATCH = {
    "page": ("(ol.a_type = 'page' AND ol.a_id = p.id) OR (ol.b_type = 'page' AND ol.b_id = p.id)"),
    "note_block": (
        "(ol.a_type = 'note_block' AND ol.a_id = (cc.summary_locator->>'note_block_id')::uuid) "
        "OR (ol.b_type = 'note_block' AND ol.b_id = (cc.summary_locator->>'note_block_id')::uuid)"
    ),
}


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


@pytest.mark.parametrize("entity,link_match", NOTE_OBJECT_LINK_MATCH.items())
@pytest.mark.parametrize("scope_type", ["media", "library", "conversation"])
def test_note_object_cells_are_object_links_exists(
    entity: str, link_match: str, scope_type: str
) -> None:
    # page/note_block scope by an object_links EXISTS subquery keyed on the object's
    # (type, id); every scope flavor wires the same link-match predicate.
    result = scope_filter_sql(scope_type, uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    sql = result[0]
    assert "EXISTS (" in sql
    assert "FROM object_links ol" in sql
    assert link_match in sql


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
