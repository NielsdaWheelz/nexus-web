"""Unit tests for the conversation-distillate reducer (grounding + citations + fingerprint).

Pure-function level (no DB): the reducer's ``materialize`` grounds claims by
``message_index`` (``ground_indices('drop')``, AC-8), emits one ``message``-target
citation per grounded claim with a self-supplied deep link (AC-4/D-4), and builds
``content_md`` whose ``[N]`` markers align with the dense citation ordinals.
"""

from uuid import uuid4

import pytest

from nexus.services.artifacts.reducers.conversation_distillate import (
    CONVERSATION_DISTILLATE_REDUCER,
    DistillateInputs,
    _ClaimOut,
    _DistillateSynthesis,
    _OfferedMessage,
)
from nexus.services.resource_graph.refs import ResourceRef

pytestmark = pytest.mark.unit


def _offered(n: int) -> list[_OfferedMessage]:
    return [
        _OfferedMessage(index=i, message_id=uuid4(), role="user", content=f"turn {i}")
        for i in range(n)
    ]


def _inputs(offered: list[_OfferedMessage]) -> DistillateInputs:
    return DistillateInputs(
        conversation_id=uuid4(),
        offered=offered,
        active_leaf_message_id=offered[-1].message_id if offered else None,
        message_count=len(offered),
    )


def test_grounded_claims_cite_their_message_with_deep_link() -> None:
    offered = _offered(3)
    inputs = _inputs(offered)
    subject = ResourceRef(scheme="conversation", id=inputs.conversation_id)
    result = _DistillateSynthesis(
        summary_md="Two things settled.",
        claims=[
            _ClaimOut(text="First idea", message_index=0),
            _ClaimOut(text="Second idea", message_index=2),
        ],
    )
    content_md, citations = CONVERSATION_DISTILLATE_REDUCER.materialize(
        None, uuid4(), subject, inputs, result
    )
    assert [c.ordinal for c in citations] == [1, 2]
    assert [c.target.scheme for c in citations] == ["message", "message"]
    assert citations[0].target.id == offered[0].message_id
    assert citations[1].target.id == offered[2].message_id
    for ordinal, citation in enumerate(citations, start=1):
        mid = citation.target.id
        assert citation.snapshot.deep_link == (
            f"/conversations/{inputs.conversation_id}#message-{mid}"
        )
        assert f"[{ordinal}]" in content_md
    assert content_md.startswith("Two things settled.")


def test_claim_citing_unoffered_index_is_dropped() -> None:
    offered = _offered(2)
    inputs = _inputs(offered)
    subject = ResourceRef(scheme="conversation", id=inputs.conversation_id)
    result = _DistillateSynthesis(
        summary_md="Only one grounded.",
        claims=[
            _ClaimOut(text="Valid", message_index=1),
            _ClaimOut(text="Hallucinated", message_index=9),
        ],
    )
    content_md, citations = CONVERSATION_DISTILLATE_REDUCER.materialize(
        None, uuid4(), subject, inputs, result
    )
    assert [c.ordinal for c in citations] == [1]
    assert citations[0].target.id == offered[1].message_id
    assert "[1]" in content_md and "[2]" not in content_md


def test_fingerprint_records_leaf_and_count() -> None:
    offered = _offered(4)
    inputs = _inputs(offered)
    covered = CONVERSATION_DISTILLATE_REDUCER.fingerprint(None, inputs)
    assert covered == [
        {
            "kind": "conversation",
            "id": str(inputs.conversation_id),
            "active_leaf_message_id": str(offered[-1].message_id),
            "message_count": 4,
        }
    ]


def test_freshness_signature_changes_when_leaf_or_count_changes() -> None:
    sig = CONVERSATION_DISTILLATE_REDUCER.freshness_signature
    base = [
        {"kind": "conversation", "id": "c", "active_leaf_message_id": "leaf-a", "message_count": 3}
    ]
    same = [
        {"kind": "conversation", "id": "c", "active_leaf_message_id": "leaf-a", "message_count": 3}
    ]
    changed_leaf = [
        {"kind": "conversation", "id": "c", "active_leaf_message_id": "leaf-b", "message_count": 3}
    ]
    changed_count = [
        {"kind": "conversation", "id": "c", "active_leaf_message_id": "leaf-a", "message_count": 4}
    ]
    assert sig(base) == sig(same)
    assert sig(base) != sig(changed_leaf)
    assert sig(base) != sig(changed_count)
