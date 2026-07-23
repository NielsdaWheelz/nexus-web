"""Conversation Dossier policy and all-branch binding."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.presence import present
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.artifacts.bindings._shared import (
    Candidate,
    StandardSynthesis,
    materialize_standard,
    synthesis_prompt,
    synthesis_user_content,
)
from nexus.services.artifacts.bindings.base import DossierBindingBase, DossierInputTooLarge
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    AudienceUser,
    DossierBuildFailureCode,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectResource,
)
from nexus.services.artifacts.manifests import (
    ConversationComplete,
    ConversationInputManifestV1,
    InputManifestV1,
)
from nexus.services.artifacts.subject_policy import ResolvedSubject, decode_resource_locator
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.context import list_context_refs
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot

_MAX_MESSAGES = 1_000
_INPUT_CHAR_BUDGET = 80_000


@dataclass(frozen=True, slots=True)
class _ConversationCollected:
    candidates: list[Candidate]
    manifest: ConversationInputManifestV1


@dataclass(frozen=True, slots=True)
class _ConversationWitness:
    candidates: list[Candidate]
    manifest: ConversationInputManifestV1


@dataclass(frozen=True, slots=True)
class ConversationCoverage:
    message_refs: tuple[str, ...]
    context_refs: tuple[str, ...]


class ConversationBinding(DossierBindingBase):
    subject_scheme: str = "conversation"
    llm_operation: BackgroundLlmOperation = "dossier_conversation"
    profile: str = "balanced"
    reasoning: ReasoningLevel = "medium"
    max_output_tokens: int = 5000
    schema: type[BaseModel] = StandardSynthesis
    system_prompt: str = synthesis_prompt("a complete, branched conversation")

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,  # noqa: ARG002
    ) -> _ConversationCollected:
        return _collect(db, resolved, audience)

    def empty_failure(self, collected: _ConversationCollected) -> DossierBuildFailureCode | None:
        return DossierBuildFailureCode.NoSourceMaterial if not collected.candidates else None

    def build_user_content(self, collected: _ConversationCollected, instruction: str | None) -> str:
        return synthesis_user_content(
            candidates=collected.candidates,
            heading="ALL-BRANCH CONVERSATION MESSAGES AND ATTACHED CONTEXT",
            context=(
                "Shared prefixes occur once. Parent facts in each message describe "
                "the branch topology; synthesize across every branch."
            ),
            instruction=instruction,
        )

    def validation_witness(
        self,
        db: Session,  # noqa: ARG002
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,  # noqa: ARG002
        collected: _ConversationCollected,
    ) -> _ConversationWitness:
        return _ConversationWitness(
            candidates=collected.candidates,
            manifest=collected.manifest,
        )

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: _ConversationWitness,
    ) -> bool:
        live = _collect(db, resolved, audience)
        return live.manifest == witness.manifest

    def materialize(
        self,
        collected: _ConversationCollected,  # noqa: ARG002
        decoded_output: BaseModel,
        witness: _ConversationWitness,
    ) -> tuple[str, list[CitationInput]]:
        return materialize_standard(decoded_output, witness.candidates)

    def input_manifest(self, collected: _ConversationCollected) -> InputManifestV1:
        return collected.manifest

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        return _collect(db, resolved, audience).manifest

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        return isinstance(stored, ConversationInputManifestV1) and stored == live

    def coverage(self, manifest: InputManifestV1) -> ConversationCoverage:
        if not isinstance(manifest, ConversationInputManifestV1):
            raise AssertionError("conversation coverage requires conversation manifest")
        return ConversationCoverage(
            message_refs=tuple(manifest.message_refs),
            context_refs=tuple(manifest.context_refs),
        )


class ConversationSubjectPolicy:
    subject_scheme: str = "conversation"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="conversation",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "conversation":
            raise InvalidSubjectLocator()
        row = (
            db.execute(
                text("SELECT owner_user_id FROM conversations WHERE id = :id"),
                {"id": locator.ref.id},
            )
            .mappings()
            .first()
        )
        if row is None or UUID(str(row["owner_user_id"])) != requester_user_id:
            raise NotFoundError(message="Conversation not found")
        return ResolvedSubject(
            scheme="conversation",
            subject_id=locator.ref.id,
            ref=locator.ref,
            detail=UUID(str(row["owner_user_id"])),
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        owner_id = db.execute(
            text("SELECT owner_user_id FROM conversations WHERE id = :id"),
            {"id": resolved.subject_id},
        ).scalar_one_or_none()
        if owner_id is None or UUID(str(owner_id)) != requester_user_id:
            raise NotFoundError(message="Conversation not found")

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        owner = _conversation_owner_from_resolved(resolved)
        return AudienceUser(user_id=owner)

    def collection_viewer(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID | None:
        return _audience_user(audience)

    def requester_billing(self, resolved: ResolvedSubject, requester_user_id: UUID) -> UUID:
        return requester_user_id

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        return _audience_user(audience)

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> list[ResourceRef]:
        collected = _collect(db, resolved, audience)
        return [candidate.target for candidate in collected.candidates]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="route",
            href=f"/conversations/{ref.id}",
            unresolved_reason=None,
        )


def _collect(
    db: Session, resolved: ResolvedSubject, audience: AudienceScope
) -> _ConversationCollected:
    owner_id = _audience_user(audience)
    rows = (
        db.execute(
            text(
                "SELECT id, seq, role, content, parent_message_id, updated_at "
                "FROM messages WHERE conversation_id = :conversation_id "
                "AND status = 'complete' ORDER BY seq, id"
            ),
            {"conversation_id": resolved.subject_id},
        )
        .mappings()
        .all()
    )
    if len(rows) > _MAX_MESSAGES or sum(len(str(row["content"] or "")) for row in rows) > (
        _INPUT_CHAR_BUDGET
    ):
        raise DossierInputTooLarge
    candidates: list[Candidate] = []
    topology_rows: list[dict[str, str | int | None]] = []
    for row in rows:
        message_id = UUID(str(row["id"]))
        content = str(row["content"] or "")
        topology_rows.append(
            {
                "id": str(message_id),
                "seq": int(row["seq"]),
                "parent": (
                    str(row["parent_message_id"]) if row["parent_message_id"] is not None else None
                ),
                "role": str(row["role"]),
                "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
                "updated_at": str(row["updated_at"]),
            }
        )
        if content.strip():
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=ResourceRef(scheme="message", id=message_id),
                    text=(
                        f"{row['role']} message seq={row['seq']} "
                        f"parent={row['parent_message_id'] or 'root'}:\n{content}"
                    ),
                    snapshot=CitationSnapshot(
                        title=f"{str(row['role']).title()} message",
                        excerpt=content[:600],
                        result_type="message",
                        deep_link=(f"/conversations/{resolved.subject_id}?message={message_id}"),
                    ),
                )
            )

    contexts = list_context_refs(
        db,
        viewer_id=owner_id,
        conversation_id=resolved.subject_id,
    )
    if sum(
        len(
            context.resolved.inline_body
            or context.resolved.summary
            or context.resolved.label
        )
        for context in contexts
    ) + sum(len(str(row["content"] or "")) for row in rows) > _INPUT_CHAR_BUDGET:
        raise DossierInputTooLarge
    context_rows: list[dict[str, str]] = []
    for context in contexts:
        if context.resolved.missing:
            continue
        body = context.resolved.inline_body or context.resolved.summary or context.resolved.label
        context_rows.append(
            {
                "ref": context.target.uri,
                "content_sha256": hashlib.sha256(body.encode()).hexdigest(),
            }
        )
        candidates.append(
            Candidate(
                index=len(candidates),
                target=context.target,
                text=f"Attached Context — {context.resolved.label}:\n{body}",
                snapshot=CitationSnapshot(
                    title=context.resolved.label,
                    excerpt=body[:600],
                    result_type=context.target.scheme,
                    deep_link=context.activation.href,
                ),
            )
        )
    fingerprint = hashlib.sha256(
        json.dumps(
            {"messages": topology_rows, "contexts": context_rows},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return _ConversationCollected(
        candidates=candidates,
        manifest=ConversationInputManifestV1(
            conversation_ref=resolved.ref.uri,
            message_refs=[
                ResourceRef(scheme="message", id=UUID(str(row["id"]))).uri for row in rows
            ],
            context_refs=[context.target.uri for context in contexts],
            topology_fingerprint=present(fingerprint),
            completeness=ConversationComplete(),
        ),
    )


def _audience_user(audience: AudienceScope) -> UUID:
    if not isinstance(audience, AudienceUser):
        raise AssertionError("conversation dossier audience must be a user")
    return audience.user_id


def _conversation_owner_from_resolved(resolved: ResolvedSubject) -> UUID:
    if not isinstance(resolved.detail, UUID):
        raise AssertionError("resolved conversation must carry its owner")
    return resolved.detail


BINDING = ConversationBinding()
POLICY = ConversationSubjectPolicy()
