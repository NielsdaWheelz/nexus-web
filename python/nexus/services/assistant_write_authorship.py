"""Durable machine-authorship owner for additive Chat write targets.

One normalized association links each concrete created target to the canonical
generation tool position that owns its stable effect identity.  The association
outlives Chat projections and target deletion so Undo and later user cleanup do
not erase the audit fact.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import cast
from uuid import UUID, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    AssistantWriteAuthorship,
    ConsumptionQueueItem,
    Conversation,
    Highlight,
    LibraryEntry,
    LLMCall,
    LLMToolPosition,
    Membership,
    MessageToolCall,
    NoteBlock,
    ResourceEdge,
)
from nexus.schemas.machine_authorship import (
    MachineAuthorshipOut,
    MachineAuthorshipTargetKind,
)
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.tool_authority import ToolPositionRecord

_REF_TARGET_KIND: dict[str, MachineAuthorshipTargetKind] = {
    "entry": "library_entry",
    "note_block": "note_block",
    "highlight": "highlight",
    "edge": "resource_edge",
    "queue": "queue_item",
}
_TARGET_REF_KIND: dict[MachineAuthorshipTargetKind, str] = {
    target_kind: ref_kind for ref_kind, target_kind in _REF_TARGET_KIND.items()
}
_TARGET_COUNT_BOUNDS_BY_TOOL: dict[
    str,
    dict[MachineAuthorshipTargetKind, tuple[int, int]],
] = {
    "nexus.library.add": {"library_entry": (0, 1)},
    "nexus.note.create": {"note_block": (1, 1)},
    "nexus.highlight.create": {"highlight": (1, 1), "note_block": (0, 1)},
    "nexus.edge.create": {"resource_edge": (1, 1)},
    "nexus.queue.add": {"queue_item": (0, 1)},
}
_ALLOWED_TARGETS_BY_TOOL: dict[str, frozenset[MachineAuthorshipTargetKind]] = {
    tool_id: frozenset(bounds) for tool_id, bounds in _TARGET_COUNT_BOUNDS_BY_TOOL.items()
}


def persist_assistant_write_authorships(
    db: Session,
    *,
    viewer_id: UUID,
    tool_call_id: UUID,
    position: ToolPositionRecord,
    created_refs: Sequence[Mapping[str, object]],
) -> tuple[MachineAuthorshipOut, ...]:
    """Stage exact target associations in the write's terminal transaction."""

    expected_effect_identity = _expected_effect_identity(position)
    if position.effect_identity != expected_effect_identity:
        raise AssertionError("assistant write position lacks its exact stable effect identity")
    if position.canonical_tool_id not in _ALLOWED_TARGETS_BY_TOOL:
        raise AssertionError("machine authorship received a non-write tool position")

    tool_call = db.scalar(
        select(MessageToolCall)
        .join(Conversation, Conversation.id == MessageToolCall.conversation_id)
        .where(
            MessageToolCall.id == tool_call_id,
            Conversation.owner_user_id == viewer_id,
        )
        .with_for_update()
    )
    if (
        tool_call is None
        or tool_call.tool_position_id != position.id
        or tool_call.canonical_tool_id != position.canonical_tool_id
        or tool_call.tool_call_index != position.position
        or tool_call.status != "complete"
        or tool_call.reverted_at is not None
    ):
        raise AssertionError("assistant write projection differs from its canonical position")
    if tool_call.result_refs != list(created_refs):
        raise AssertionError("assistant write created refs differ from its Chat projection")

    targets = _expected_created_targets(
        tool_id=position.canonical_tool_id,
        created_refs=created_refs,
    )
    projected: list[MachineAuthorshipOut] = []
    for target, ref in zip(targets, created_refs, strict=True):
        target_kind, target_id = target
        _assert_owned_target(
            db,
            viewer_id=viewer_id,
            target_kind=target_kind,
            target_id=target_id,
            ref=ref,
        )
        authorship_id = _authorship_id(
            position_id=position.id,
            target_kind=target_kind,
            target_id=target_id,
        )
        existing = db.scalar(
            select(AssistantWriteAuthorship)
            .where(
                AssistantWriteAuthorship.target_kind == target_kind,
                AssistantWriteAuthorship.target_id == target_id,
            )
            .with_for_update()
        )
        if existing is None:
            existing = AssistantWriteAuthorship(
                id=authorship_id,
                tool_position_id=position.id,
                target_kind=target_kind,
                target_id=target_id,
            )
            db.add(existing)
            db.flush()
        elif existing.id != authorship_id or existing.tool_position_id != position.id:
            raise AssertionError("created target already has a different machine author")
        projected.append(
            _project_authorship(
                existing,
                position_id=position.id,
                generation_id=position.generation_id,
                generation_seq=position.generation_seq,
                tool_position=position.position,
                effect_identity=position.effect_identity,
            )
        )
    associated_rows = list(
        db.scalars(
            select(AssistantWriteAuthorship)
            .where(AssistantWriteAuthorship.tool_position_id == position.id)
            .with_for_update()
        )
    )
    associated_targets = [(row.target_kind, row.target_id) for row in associated_rows]
    if len(associated_targets) != len(set(associated_targets)) or set(associated_targets) != set(
        targets
    ):
        raise AssertionError(
            "persisted assistant write authorship differs from its exact created targets"
        )
    return tuple(projected)


def machine_authorships_for_tool_calls(
    db: Session,
    *,
    tool_calls: Sequence[MessageToolCall],
) -> dict[UUID, list[MachineAuthorshipOut]]:
    """Batch provenance for already-authorized Chat tool projections."""

    successful_writes = tuple(
        tool
        for tool in tool_calls
        if tool.record_kind == "current_execution"
        and tool.canonical_tool_id in _ALLOWED_TARGETS_BY_TOOL
        and tool.status == "complete"
    )
    for tool in successful_writes:
        if tool.tool_position_id is None:
            raise AssertionError("successful Chat write lacks its canonical generation position")
    position_to_tool = {cast(UUID, tool.tool_position_id): tool for tool in successful_writes}
    if len(position_to_tool) != len(successful_writes):
        raise AssertionError("successful Chat writes share one canonical generation position")
    if not position_to_tool:
        return {}
    rows = db.execute(
        select(AssistantWriteAuthorship, LLMToolPosition, LLMCall.generation_seq)
        .join(
            LLMToolPosition,
            LLMToolPosition.id == AssistantWriteAuthorship.tool_position_id,
        )
        .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
        .where(AssistantWriteAuthorship.tool_position_id.in_(position_to_tool))
        .order_by(
            AssistantWriteAuthorship.tool_position_id,
            AssistantWriteAuthorship.created_at,
            AssistantWriteAuthorship.id,
        )
    ).all()
    result: dict[UUID, list[MachineAuthorshipOut]] = {}
    for authorship, position, generation_seq in rows:
        tool = position_to_tool[position.id]
        if (
            tool.canonical_tool_id != position.canonical_tool_id
            or tool.tool_call_index != position.position
        ):
            raise AssertionError("Chat write projection changed its generation position")
        result.setdefault(tool.id, []).append(
            _project_authorship_row(authorship, position, generation_seq)
        )
    for tool in successful_writes:
        if tool.canonical_tool_id is None:
            raise AssertionError("successful Chat write lacks its canonical tool id")
        expected = _expected_created_targets(
            tool_id=tool.canonical_tool_id,
            created_refs=cast(Sequence[Mapping[str, object]], tool.result_refs),
        )
        actual_rows = result.get(tool.id, [])
        actual = {(row.target_kind, row.target_id): row for row in actual_rows}
        if len(actual_rows) != len(actual) or set(actual) != set(expected):
            raise AssertionError(
                "successful Chat write authorship differs from its exact created targets"
            )
        result[tool.id] = [actual[target] for target in expected]
    return result


def machine_authorship_for_resource_uri(
    db: Session,
    *,
    viewer_id: UUID,
    resource_uri: str,
) -> MachineAuthorshipOut | None:
    """Return provenance when an authorized model read targets authored content."""

    parsed = parse_resource_ref(resource_uri)
    if isinstance(parsed, ResourceRefParseFailure):
        return None
    target_kind: MachineAuthorshipTargetKind
    if parsed.scheme == "note_block":
        target_kind = "note_block"
    elif parsed.scheme == "highlight":
        target_kind = "highlight"
    else:
        return None
    # Provenance never widens resource visibility.  Callers normally performed
    # this read already; repeating the shared predicate makes this helper safe
    # as an independent semantic boundary.
    assert_ref_visible(db, viewer_id=viewer_id, ref=parsed)
    return _machine_authorship_for_target(
        db,
        viewer_id=viewer_id,
        target_kind=target_kind,
        target_id=parsed.id,
    )


def machine_authorship_for_edge(
    db: Session,
    *,
    viewer_id: UUID,
    edge_id: UUID,
) -> MachineAuthorshipOut | None:
    """Return provenance for an owner-visible relation result."""

    visible = db.scalar(
        select(ResourceEdge.id).where(
            ResourceEdge.id == edge_id,
            ResourceEdge.user_id == viewer_id,
        )
    )
    if visible is None:
        return None
    return _machine_authorship_for_target(
        db,
        viewer_id=viewer_id,
        target_kind="resource_edge",
        target_id=edge_id,
    )


def _machine_authorship_for_target(
    db: Session,
    *,
    viewer_id: UUID,
    target_kind: MachineAuthorshipTargetKind,
    target_id: UUID,
) -> MachineAuthorshipOut | None:
    producer = _producer_for_target(
        db,
        viewer_id=viewer_id,
        target_kind=target_kind,
        target_id=target_id,
    )
    row = db.execute(
        select(AssistantWriteAuthorship, LLMToolPosition, LLMCall.generation_seq)
        .join(
            LLMToolPosition,
            LLMToolPosition.id == AssistantWriteAuthorship.tool_position_id,
        )
        .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
        .where(
            AssistantWriteAuthorship.target_kind == target_kind,
            AssistantWriteAuthorship.target_id == target_id,
        )
    ).one_or_none()
    if row is None:
        if producer is None:
            return None
        raise AssertionError("machine-authored retrieval target lacks its exact association")
    authorship, position, generation_seq = row
    if producer is not None and producer.tool_position_id != authorship.tool_position_id:
        raise AssertionError("machine-authored retrieval target changed its producing position")
    return _project_authorship_row(authorship, position, generation_seq)


def _producer_for_target(
    db: Session,
    *,
    viewer_id: UUID,
    target_kind: MachineAuthorshipTargetKind,
    target_id: UUID,
) -> MessageToolCall | None:
    ref_kind = _TARGET_REF_KIND[target_kind]
    candidates = list(
        db.scalars(
            select(MessageToolCall)
            .join(Conversation, Conversation.id == MessageToolCall.conversation_id)
            .where(
                Conversation.owner_user_id == viewer_id,
                MessageToolCall.record_kind == "current_execution",
                MessageToolCall.status == "complete",
                MessageToolCall.canonical_tool_id.in_(_ALLOWED_TARGETS_BY_TOOL),
                MessageToolCall.result_refs.contains([{"kind": ref_kind, "id": str(target_id)}]),
            )
            .order_by(MessageToolCall.created_at, MessageToolCall.id)
        )
    )
    exact = [
        candidate
        for candidate in candidates
        if (target_kind, target_id)
        in _expected_created_targets(
            tool_id=cast(str, candidate.canonical_tool_id),
            created_refs=cast(Sequence[Mapping[str, object]], candidate.result_refs),
        )
    ]
    if len(exact) > 1:
        raise AssertionError("machine-authored target has multiple producing tool calls")
    if not exact:
        return None
    producer = exact[0]
    if producer.tool_position_id is None:
        raise AssertionError("machine-authored target producer lacks its generation position")
    return producer


def _project_authorship_row(
    authorship: AssistantWriteAuthorship,
    position: LLMToolPosition,
    generation_seq: int,
) -> MachineAuthorshipOut:
    allowed_targets = _ALLOWED_TARGETS_BY_TOOL.get(position.canonical_tool_id)
    if allowed_targets is None or authorship.target_kind not in allowed_targets:
        raise AssertionError("persisted machine authorship differs from its write tool contract")
    return _project_authorship(
        authorship,
        position_id=position.id,
        generation_id=position.generation_id,
        generation_seq=generation_seq,
        tool_position=position.position,
        effect_identity=cast(dict[str, object] | None, position.effect_identity),
    )


def _project_authorship(
    authorship: AssistantWriteAuthorship,
    *,
    position_id: UUID,
    generation_id: UUID,
    generation_seq: int,
    tool_position: int,
    effect_identity: dict[str, object] | None,
) -> MachineAuthorshipOut:
    position_path = f"generation/{generation_seq}/tool/{tool_position}"
    expected = {
        "effect_id": str(position_id),
        "generation_id": str(generation_id),
        "position_path": position_path,
    }
    if effect_identity != expected:
        raise AssertionError("persisted machine authorship has an invalid effect identity")
    if authorship.target_kind not in frozenset(_REF_TARGET_KIND.values()):
        raise AssertionError("persisted machine authorship has an unknown target kind")
    target_kind = cast(MachineAuthorshipTargetKind, authorship.target_kind)
    if authorship.id != _authorship_id(
        position_id=position_id,
        target_kind=target_kind,
        target_id=authorship.target_id,
    ):
        raise AssertionError("persisted machine authorship has an invalid stable identity")
    return MachineAuthorshipOut(
        target_kind=target_kind,
        target_id=authorship.target_id,
        generation_id=generation_id,
        generation_seq=generation_seq,
        tool_position=tool_position,
        position_path=position_path,
        effect_id=position_id,
    )


def _expected_effect_identity(position: ToolPositionRecord) -> dict[str, object]:
    return {
        "effect_id": str(position.id),
        "generation_id": str(position.generation_id),
        "position_path": position.path,
    }


def _authorship_id(
    *,
    position_id: UUID,
    target_kind: MachineAuthorshipTargetKind,
    target_id: UUID,
) -> UUID:
    return uuid5(
        position_id,
        f"nexus-assistant-write-authorship.v1/{target_kind}/{target_id}",
    )


def _target_from_ref(
    ref: Mapping[str, object],
) -> tuple[MachineAuthorshipTargetKind, UUID]:
    raw_kind = ref.get("kind")
    if not isinstance(raw_kind, str) or raw_kind not in _REF_TARGET_KIND:
        raise AssertionError("assistant write produced an unknown created-ref kind")
    raw_id = ref.get("id")
    if not isinstance(raw_id, str):
        raise AssertionError("assistant write created ref lacks a canonical target id")
    try:
        target_id = UUID(raw_id)
    except ValueError as exc:
        raise AssertionError("assistant write created ref target id is not a UUID") from exc
    return _REF_TARGET_KIND[raw_kind], target_id


def _expected_created_targets(
    *,
    tool_id: str,
    created_refs: Sequence[Mapping[str, object]],
) -> tuple[tuple[MachineAuthorshipTargetKind, UUID], ...]:
    bounds = _TARGET_COUNT_BOUNDS_BY_TOOL.get(tool_id)
    if bounds is None:
        raise AssertionError("machine authorship received an unknown write tool")
    targets = tuple(_target_from_ref(ref) for ref in created_refs)
    if any(target_kind not in bounds for target_kind, _target_id in targets):
        raise AssertionError("assistant write produced a target outside its closed contract")
    if len(set(targets)) != len(targets):
        raise AssertionError("assistant write repeated one created target")
    counts = Counter(target_kind for target_kind, _target_id in targets)
    for target_kind, (minimum, maximum) in bounds.items():
        actual = counts[target_kind]
        if actual < minimum:
            raise AssertionError(
                f"assistant write omitted its required {target_kind} created target"
            )
        if actual > maximum:
            raise AssertionError(
                f"assistant write exceeded its {target_kind} created-target cardinality"
            )
    return targets


def _assert_owned_target(
    db: Session,
    *,
    viewer_id: UUID,
    target_kind: MachineAuthorshipTargetKind,
    target_id: UUID,
    ref: Mapping[str, object],
) -> None:
    owned = False
    if target_kind == "library_entry":
        target_scheme = ref.get("target_scheme")
        raw_library_id = ref.get("library_id")
        raw_target_id = ref.get("target_id")
        if (
            target_scheme not in {"media", "podcast"}
            or not isinstance(raw_library_id, str)
            or not isinstance(raw_target_id, str)
        ):
            raise AssertionError("library authorship ref lost its concrete target identity")
        try:
            library_id = UUID(raw_library_id)
            resource_id = UUID(raw_target_id)
        except ValueError as exc:
            raise AssertionError("library authorship ref contains a malformed UUID") from exc
        target_column = (
            LibraryEntry.media_id if target_scheme == "media" else LibraryEntry.podcast_id
        )
        owned = (
            db.scalar(
                select(LibraryEntry.id)
                .join(Membership, Membership.library_id == LibraryEntry.library_id)
                .where(
                    LibraryEntry.id == target_id,
                    LibraryEntry.library_id == library_id,
                    target_column == resource_id,
                    Membership.user_id == viewer_id,
                )
            )
            is not None
        )
    elif target_kind == "note_block":
        owned = (
            db.scalar(
                select(NoteBlock.id).where(
                    NoteBlock.id == target_id, NoteBlock.user_id == viewer_id
                )
            )
            is not None
        )
    elif target_kind == "highlight":
        owned = (
            db.scalar(
                select(Highlight.id).where(
                    Highlight.id == target_id, Highlight.user_id == viewer_id
                )
            )
            is not None
        )
    elif target_kind == "resource_edge":
        owned = (
            db.scalar(
                select(ResourceEdge.id).where(
                    ResourceEdge.id == target_id,
                    ResourceEdge.user_id == viewer_id,
                    ResourceEdge.origin == "assistant",
                )
            )
            is not None
        )
    elif target_kind == "queue_item":
        owned = (
            db.scalar(
                select(ConsumptionQueueItem.id).where(
                    ConsumptionQueueItem.id == target_id,
                    ConsumptionQueueItem.user_id == viewer_id,
                    ConsumptionQueueItem.source == "assistant",
                )
            )
            is not None
        )
    else:
        raise AssertionError("machine authorship target kind is outside its closed union")
    if not owned:
        raise AssertionError(
            f"assistant write {target_kind} target is absent or not owned by its actor"
        )


__all__ = [
    "machine_authorship_for_edge",
    "machine_authorship_for_resource_uri",
    "machine_authorships_for_tool_calls",
    "persist_assistant_write_authorships",
]
