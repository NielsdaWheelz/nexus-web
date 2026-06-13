from __future__ import annotations

from typing import cast
from uuid import uuid4

import pytest

from nexus.errors import InvalidRequestError
from nexus.services.resource_graph.policy import (
    APP_SEARCH_SCOPE_TARGET_SCHEMES,
    CITATION_OUTPUT_SOURCE_SCHEMES,
    CONVERSATION_CONTEXT_SCOPE_ORIGINS,
    EDGE_SHAPE_POLICIES,
    NOTE_MEDIA_SCOPE_ORIGINS,
    SEARCH_SCOPE_EDGE_KIND,
    SYNAPSE_SOURCE_SCHEMES,
    SYNAPSE_TARGET_SCHEMES,
    validate_edge_shape,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EDGE_ORIGINS, EdgeCreate

pytestmark = pytest.mark.unit


def _ref(scheme: str) -> ResourceRef:
    return ResourceRef(scheme=cast(ResourceScheme, scheme), id=uuid4())


def test_every_origin_has_one_policy_entry() -> None:
    assert set(EDGE_SHAPE_POLICIES) == set(EDGE_ORIGINS)
    for origin, policy in EDGE_SHAPE_POLICIES.items():
        assert policy.origin == origin
        assert policy.writer
        assert policy.cleanup
        assert policy.rendering


def test_search_scope_policy_constants_are_explicit() -> None:
    assert SEARCH_SCOPE_EDGE_KIND == "context"
    assert NOTE_MEDIA_SCOPE_ORIGINS == ("user", "note_body", "highlight_note")
    assert CONVERSATION_CONTEXT_SCOPE_ORIGINS == ("user", "citation", "system")
    assert APP_SEARCH_SCOPE_TARGET_SCHEMES == ("media", "library")
    assert CITATION_OUTPUT_SOURCE_SCHEMES == (
        "message",
        "oracle_reading",
        "library_intelligence_revision",
    )
    assert SYNAPSE_SOURCE_SCHEMES == ("media", "page", "note_block", "highlight")
    assert SYNAPSE_TARGET_SCHEMES == ("media", "note_block")


def test_policy_rejects_unowned_origin_shapes() -> None:
    for edge in (
        EdgeCreate(source=_ref("page"), target=_ref("media"), kind="context", origin="citation"),
        EdgeCreate(source=_ref("page"), target=_ref("media"), kind="context", origin="system"),
        EdgeCreate(source=_ref("media"), target=_ref("page"), kind="context", origin="note_body"),
        EdgeCreate(
            source=_ref("conversation"), target=_ref("media"), kind="context", origin="synapse"
        ),
        EdgeCreate(
            source=_ref("page"),
            target=_ref("library_intelligence_revision"),
            kind="context",
            origin="synapse",
        ),
    ):
        with pytest.raises(InvalidRequestError):
            validate_edge_shape(edge)
