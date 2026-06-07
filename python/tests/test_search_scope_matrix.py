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
    "content_chunk": "cc.media_id = :scope_id",
    "fragment": "f.media_id = :scope_id",
    "evidence_span": "es.media_id = :scope_id",
    "highlight": "h.anchor_media_id = :scope_id",
    "contributor": "cc.media_id = :scope_id",
}


def test_all_scope_is_unscoped_for_every_entity() -> None:
    for entity in ENTITIES:
        result = scope_filter_sql("all", None, entity)
        assert result == ("", {}), entity


@pytest.mark.parametrize("entity", ENTITIES)
@pytest.mark.parametrize("scope_type", ["media", "library", "conversation"])
def test_every_cell_is_either_unsupported_or_a_scoped_fragment(entity: str, scope_type: str) -> None:
    scope_id = uuid4()
    result = scope_filter_sql(scope_type, scope_id, entity)
    if (entity, scope_type) in UNSUPPORTED_CELLS:
        assert isinstance(result, ScopeUnsupported)
        assert result is UNSUPPORTED
        return
    assert not isinstance(result, ScopeUnsupported), f"{entity}/{scope_type} unexpectedly UNSUPPORTED"
    sql, params = result
    assert sql.strip().startswith("AND"), f"{entity}/{scope_type}: {sql!r}"
    assert params == {"scope_id": scope_id}


@pytest.mark.parametrize("entity,fragment", MEDIA_SCOPE_COLUMN.items())
def test_media_scope_targets_the_entity_column(entity: str, fragment: str) -> None:
    result = scope_filter_sql("media", uuid4(), entity)
    assert not isinstance(result, ScopeUnsupported)
    assert fragment in result[0]


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
