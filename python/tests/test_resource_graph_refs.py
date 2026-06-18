"""Unit tests for the ResourceRef grammar (``resource_graph.refs``).

Pure parsing/formatting: no database. Pins the hard rename (D2: no ``span:``/
``chunk:`` aliases), canonical-UUID strictness, the typed parse failure, and
the closed scheme vocabulary.
"""

from __future__ import annotations

from typing import assert_never, get_args
from uuid import UUID, uuid4

import pytest

from nexus.services.resource_graph.refs import (
    RESOURCE_SCHEMES,
    ResourceRef,
    ResourceRefParseFailure,
    ResourceScheme,
    assert_resource_ref,
    parse_resource_ref,
)

pytestmark = pytest.mark.unit

PARAM_UPPERCASE_UUID = UUID("11111111-1111-4111-8111-111111111111")
PARAM_BRACED_UUID = UUID("22222222-2222-4222-8222-222222222222")
PARAM_URN_UUID = UUID("33333333-3333-4333-8333-333333333333")
PARAM_WHITESPACE_UUID = UUID("44444444-4444-4444-8444-444444444444")
PARAM_UNKNOWN_SCHEME_UUID = UUID("55555555-5555-4555-8555-555555555555")
PARAM_EMPTY_SCHEME_UUID = UUID("66666666-6666-4666-8666-666666666666")
PARAM_OLD_ALIAS_UUID = UUID("77777777-7777-4777-8777-777777777777")


def test_scheme_constant_matches_the_literal_type():
    assert get_args(ResourceScheme) == RESOURCE_SCHEMES, (
        "RESOURCE_SCHEMES must mirror the ResourceScheme Literal exactly; "
        f"literal={get_args(ResourceScheme)} tuple={RESOURCE_SCHEMES}"
    )


def test_edge_vocab_is_single_sourced():
    """LOW #20: the graph-schema module owns ``EdgeKind``/``EdgeOrigin``; the wire
    schema and citation read-model alias them, and boundary value-tuples derive
    from the Literals (no hand-listed copies that can drift)."""
    from nexus.schemas import citation as citation_schema
    from nexus.schemas import resource_graph as wire
    from nexus.services.resource_graph import schemas as graph

    assert wire.EdgeKind is graph.EdgeKind, "wire EdgeKind must alias the graph-schema source"
    assert wire.EdgeOrigin is graph.EdgeOrigin, "wire EdgeOrigin must alias the graph-schema source"
    assert citation_schema.CitationRole is graph.EdgeKind, "CitationRole must alias EdgeKind"

    assert graph.EDGE_KINDS == get_args(graph.EdgeKind)
    assert graph.EDGE_ORIGINS == get_args(graph.EdgeOrigin)
    assert wire.EDGE_KIND_VALUES == get_args(graph.EdgeKind)
    assert wire.EDGE_ORIGIN_VALUES == get_args(graph.EdgeOrigin)


def _scheme_is_handled(scheme: ResourceScheme) -> bool:
    """Exhaustive match over the scheme vocabulary (assert_never gate, §18.1).

    Adding a scheme without extending this match fails type-check and this
    test, forcing the new scheme's parse/format behavior to be considered.
    """
    if scheme == "media":
        return True
    if scheme == "library":
        return True
    if scheme == "evidence_span":
        return True
    if scheme == "content_chunk":
        return True
    if scheme == "highlight":
        return True
    if scheme == "page":
        return True
    if scheme == "note_block":
        return True
    if scheme == "fragment":
        return True
    if scheme == "conversation":
        return True
    if scheme == "message":
        return True
    if scheme == "oracle_reading":
        return True
    if scheme == "oracle_passage_anchor":
        return True
    if scheme == "library_intelligence_artifact":
        return True
    if scheme == "library_intelligence_revision":
        return True
    if scheme == "external_snapshot":
        return True
    if scheme == "contributor":
        return True
    if scheme == "podcast":
        return True
    if scheme == "reader_apparatus_item":
        return True
    assert_never(scheme)


def test_parse_round_trips_every_scheme():
    for scheme in RESOURCE_SCHEMES:
        assert _scheme_is_handled(scheme)
        resource_id = uuid4()
        parsed = parse_resource_ref(f"{scheme}:{resource_id}")
        assert parsed == ResourceRef(scheme=scheme, id=resource_id), (
            f"{scheme}: ref must parse to a typed ResourceRef; got {parsed}"
        )
        assert isinstance(parsed, ResourceRef)
        assert parsed.uri == f"{scheme}:{resource_id}", (
            f"uri property must round-trip the canonical string; got {parsed.uri}"
        )


@pytest.mark.parametrize("old_scheme", ["span", "chunk"])
def test_parse_rejects_old_aliases(old_scheme: str):
    raw = f"{old_scheme}:{uuid4()}"
    parsed = parse_resource_ref(raw)
    assert parsed == ResourceRefParseFailure(raw=raw, reason="unsupported_scheme"), (
        f"Hard rename (D2): {old_scheme!r} must be an unsupported scheme; got {parsed}"
    )


def test_parse_rejects_user_graph_tag_scheme():
    raw = f"tag:{uuid4()}"
    assert parse_resource_ref(raw) == ResourceRefParseFailure(raw=raw, reason="unsupported_scheme")
    with pytest.raises(AssertionError, match="unsupported_scheme"):
        assert_resource_ref(raw)


@pytest.mark.parametrize(
    "scheme",
    ["web", "web_result", "author", "video", "episode", "pdf", "epub", "annotation"],
)
def test_parse_rejects_product_alias_schemes(scheme: str):
    raw = f"{scheme}:{uuid4()}"
    assert parse_resource_ref(raw) == ResourceRefParseFailure(raw=raw, reason="unsupported_scheme")


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ("media", "invalid_format"),  # no colon
        ("", "invalid_format"),
        (f"media:{PARAM_UPPERCASE_UUID}".upper(), "unsupported_scheme"),  # scheme case-sensitive
        ("media:", "invalid_format"),  # empty id
        ("media:not-a-uuid", "invalid_format"),
        ("media:123", "invalid_format"),
        (f"media:{{{PARAM_BRACED_UUID}}}", "invalid_format"),  # braced UUID is non-canonical
        (f"media:urn:uuid:{PARAM_URN_UUID}", "invalid_format"),
        (f"media: {PARAM_WHITESPACE_UUID}", "invalid_format"),  # whitespace
        (f"unknown_scheme:{PARAM_UNKNOWN_SCHEME_UUID}", "unsupported_scheme"),
        (f":{PARAM_EMPTY_SCHEME_UUID}", "unsupported_scheme"),  # empty scheme
    ],
)
def test_parse_rejects_malformed_input(raw: str, reason: str):
    parsed = parse_resource_ref(raw)
    assert isinstance(parsed, ResourceRefParseFailure), f"{raw!r} must fail to parse; got {parsed}"
    assert parsed.reason == reason, f"{raw!r}: expected {reason}, got {parsed.reason}"
    assert parsed.raw == raw


def test_parse_rejects_non_canonical_uppercase_uuid():
    resource_id = uuid4()
    raw = f"media:{str(resource_id).upper()}"
    parsed = parse_resource_ref(raw)
    assert parsed == ResourceRefParseFailure(raw=raw, reason="invalid_format"), (
        f"Only canonical lowercase UUIDs are valid; got {parsed}"
    )


def test_ref_is_frozen_value_object():
    ref = ResourceRef(scheme="media", id=UUID(int=1))
    with pytest.raises(AttributeError):
        ref.scheme = "library"  # type: ignore[misc]


def test_assert_resource_ref_returns_ref_for_valid_input():
    resource_id = uuid4()
    assert assert_resource_ref(f"podcast:{resource_id}") == ResourceRef(
        scheme="podcast", id=resource_id
    )


@pytest.mark.parametrize("raw", ["span:not-a-uuid", f"span:{PARAM_OLD_ALIAS_UUID}", "garbage"])
def test_assert_resource_ref_raises_on_invalid_input(raw: str):
    with pytest.raises(AssertionError):
        assert_resource_ref(raw)
