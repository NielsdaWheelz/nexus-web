"""Dossier projection for route-neutral model-callable read tools.

The canonical generation tool ledger remains the source of execution truth.
This adapter assigns stable Dossier candidate indices to successful read
evidence and renders those indices back to the model.  Publication still
accepts only candidates reconstructed from completed durable tool positions.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.artifacts.bindings._shared import Candidate
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_graph.schemas import CitationSnapshot
from nexus.services.tool_authority import (
    ToolAuditProjection,
    ToolAuthority,
    ToolAuthorityRefused,
    ToolPositionRecord,
    read_tool_positions,
)
from nexus.services.tool_runtime.execution import ToolResult


@dataclass(frozen=True, slots=True)
class DossierToolExecutionProjection:
    """Bind one Artifact build and its initial citation candidate sequence."""

    build_id: UUID
    baseline_candidates: tuple[Candidate, ...]

    @property
    def scope_label(self) -> str:
        return "dossier_evidence"

    def lock_owner(
        self,
        db: Session,
        *,
        user_id: UUID,
        owner: LlmCallOwner,
    ) -> None:
        if owner != LlmCallOwner(kind="artifact_build", id=self.build_id):
            raise ToolAuthorityRefused("Dossier projection owner differs from the generation")
        requester = db.execute(
            text("SELECT requester_user_id FROM artifact_builds WHERE id = :build_id FOR UPDATE"),
            {"build_id": self.build_id},
        ).scalar_one_or_none()
        if requester is None or UUID(str(requester)) != user_id:
            raise ToolAuthorityRefused("Dossier projection requester is not live")

    def stage_started(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> None:
        del db, authority, position, provider_wire_name, arguments

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: ToolAuditProjection,
    ) -> None:
        del db, authority, position, result, audit

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str:
        candidates = dossier_candidates_from_ledger(
            db,
            generation_id=authority.generation_id,
            baseline_candidates=self.baseline_candidates,
        )
        index_by_target = {candidate.target.uri: candidate.index for candidate in candidates}
        current = [
            {
                "candidate_index": index_by_target[candidate.target.uri],
                "target_uri": candidate.target.uri,
            }
            for candidate in _candidates_from_result(result, start_index=0)
            if candidate.target.uri in index_by_target
        ]
        projected = _json_object(result)
        if projected.get("type") == "Success":
            projected = {**projected, "dossier_citation_candidates": current}
        return _canonical_json(projected)

    def live_write_count(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
    ) -> int | None:
        del db, authority
        return None


def dossier_candidates_from_ledger(
    db: Session,
    *,
    generation_id: UUID,
    baseline_candidates: Sequence[Candidate],
) -> tuple[Candidate, ...]:
    """Reconstruct the exact candidate order from terminal tool receipts."""

    candidates = list(baseline_candidates)
    seen = {candidate.target.uri for candidate in candidates}
    if [candidate.index for candidate in candidates] != list(range(len(candidates))):
        raise AssertionError("Dossier baseline candidate indices are not contiguous")
    for position in read_tool_positions(db, generation_id=generation_id):
        if position.replay_status != "Completed" or position.result_evidence is None:
            continue
        raw_result = position.result_evidence.get("tool_result")
        if not isinstance(raw_result, dict):
            raise AssertionError("completed Dossier tool position has no canonical result")
        for candidate in _candidates_from_result(raw_result, start_index=len(candidates)):
            if candidate.target.uri in seen:
                continue
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=candidate.target,
                    text=candidate.text,
                    snapshot=candidate.snapshot,
                )
            )
            seen.add(candidate.target.uri)
    return tuple(candidates)


def _candidates_from_result(result: Mapping[str, object], *, start_index: int) -> list[Candidate]:
    if result.get("type") != "Success" or not isinstance(result.get("value"), dict):
        return []
    candidates: list[Candidate] = []
    seen: set[str] = set()
    for node in _objects(result["value"]):
        evidence = node.get("evidence")
        if not isinstance(evidence, dict):
            continue
        target_uri = evidence.get("citation_target") or evidence.get("resource_uri")
        if not isinstance(target_uri, str) or target_uri in seen:
            continue
        parsed = parse_resource_ref(target_uri)
        if isinstance(parsed, ResourceRefParseFailure):
            continue
        title = node.get("title")
        text_value = next(
            (
                node[key]
                for key in ("text", "excerpt", "rationale")
                if isinstance(node.get(key), str) and node[key]
            ),
            title if isinstance(title, str) else target_uri,
        )
        if not isinstance(text_value, str):
            text_value = target_uri
        candidates.append(
            Candidate(
                index=start_index + len(candidates),
                target=parsed,
                text=text_value,
                snapshot=CitationSnapshot(
                    title=title if isinstance(title, str) else None,
                    excerpt=text_value[:600],
                    result_type=parsed.scheme,
                ),
            )
        )
        seen.add(target_uri)
    return candidates


def _objects(value: object) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(_objects(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_objects(child))
    return found


def _json_object(value: object) -> dict[str, Any]:
    encoded = _canonical_json(value)
    decoded = json.loads(encoded)
    if not isinstance(decoded, dict):
        raise AssertionError("tool result is not a JSON object")
    return decoded


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
