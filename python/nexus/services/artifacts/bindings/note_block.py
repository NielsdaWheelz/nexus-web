"""Note-block Dossier policy and atomic body/Connection binding."""

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
from nexus.services.artifacts.bindings._notes_shared import (
    one_hop_connection_candidates,
)
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
from nexus.services.artifacts.manifests import InputManifestV1, NoteInputManifestV1
from nexus.services.artifacts.subject_policy import ResolvedSubject, decode_resource_locator
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot

_INPUT_CHAR_BUDGET = 80_000


@dataclass(frozen=True, slots=True)
class _NoteCollected:
    candidates: list[Candidate]
    manifest: NoteInputManifestV1
    witness_fingerprint: str


@dataclass(frozen=True, slots=True)
class _NoteWitness:
    candidates: list[Candidate]
    fingerprint: str


@dataclass(frozen=True, slots=True)
class NoteCoverage:
    body_present: bool
    connection_refs: tuple[str, ...]


class NoteBinding(DossierBindingBase):
    subject_scheme: str = "note_block"
    llm_operation: BackgroundLlmOperation = "dossier_note"
    profile: str = "fast"
    reasoning: ReasoningLevel = "low"
    max_output_tokens: int = 3000
    schema: type[BaseModel] = StandardSynthesis
    system_prompt: str = synthesis_prompt("one atomic note and its current connections")

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,  # noqa: ARG002
    ) -> _NoteCollected:
        return _collect(db, resolved, audience)

    def empty_failure(self, collected: _NoteCollected) -> DossierBuildFailureCode | None:
        return DossierBuildFailureCode.NoSourceMaterial if not collected.candidates else None

    def build_user_content(self, collected: _NoteCollected, instruction: str | None) -> str:
        return synthesis_user_content(
            candidates=collected.candidates,
            heading="ATOMIC NOTE BODY AND ONE-HOP CONNECTIONS",
            context=(
                "Treat the note as one atomic body. Evidence-span candidates are "
                "exact owned evidence; otherwise the note candidate snapshots the body."
            ),
            instruction=instruction,
        )

    def validation_witness(
        self,
        db: Session,  # noqa: ARG002
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,  # noqa: ARG002
        collected: _NoteCollected,
    ) -> _NoteWitness:
        return _NoteWitness(
            candidates=collected.candidates,
            fingerprint=collected.witness_fingerprint,
        )

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: _NoteWitness,
    ) -> bool:
        return _collect(db, resolved, audience).witness_fingerprint == witness.fingerprint

    def materialize(
        self,
        collected: _NoteCollected,  # noqa: ARG002
        decoded_output: BaseModel,
        witness: _NoteWitness,
    ) -> tuple[str, list[CitationInput]]:
        return materialize_standard(decoded_output, witness.candidates)

    def input_manifest(self, collected: _NoteCollected) -> InputManifestV1:
        return collected.manifest

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        return _collect(db, resolved, audience).manifest

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        return isinstance(stored, NoteInputManifestV1) and stored == live

    def coverage(self, manifest: InputManifestV1) -> NoteCoverage:
        if not isinstance(manifest, NoteInputManifestV1):
            raise AssertionError("note coverage requires note manifest")
        from nexus.schemas.presence import Present

        return NoteCoverage(
            body_present=isinstance(manifest.body_fingerprint, Present),
            connection_refs=tuple(manifest.connection_refs),
        )


class NoteSubjectPolicy:
    subject_scheme: str = "note_block"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="note_block",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "note_block":
            raise InvalidSubjectLocator()
        owner_id = _note_owner(db, locator.ref.id)
        if owner_id != requester_user_id:
            raise NotFoundError(message="Note not found")
        return ResolvedSubject(
            scheme="note_block",
            subject_id=locator.ref.id,
            ref=locator.ref,
            detail=owner_id,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if _note_owner(db, resolved.subject_id) != requester_user_id:
            raise NotFoundError(message="Note not found")

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        owner = resolved.detail
        if not isinstance(owner, UUID):
            raise AssertionError("resolved note must carry its owner")
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
        return [candidate.target for candidate in _collect(db, resolved, audience).candidates]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="route",
            href=f"/notes/{ref.id}",
            unresolved_reason=None,
        )


def _collect(db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> _NoteCollected:
    viewer_id = _audience_user(audience)
    note = (
        db.execute(
            text(
                "SELECT body_text, updated_at FROM note_blocks "
                "WHERE id = :id AND user_id = :viewer_id"
            ),
            {"id": resolved.subject_id, "viewer_id": viewer_id},
        )
        .mappings()
        .first()
    )
    if note is None:
        raise NotFoundError(message="Note not found")
    body = str(note["body_text"] or "")
    if len(body) > _INPUT_CHAR_BUDGET:
        raise DossierInputTooLarge
    body_fingerprint = hashlib.sha256(body.encode()).hexdigest()
    evidence_rows = (
        db.execute(
            text(
                "SELECT id, span_text, citation_label FROM evidence_spans "
                "WHERE owner_kind = 'note_block' AND owner_id = :id ORDER BY id"
            ),
            {"id": resolved.subject_id},
        )
        .mappings()
        .all()
    )
    if len(body) + sum(len(str(row["span_text"] or "")) for row in evidence_rows) > (
        _INPUT_CHAR_BUDGET
    ):
        raise DossierInputTooLarge
    candidates: list[Candidate] = []
    evidence_facts: list[dict[str, str]] = []
    for evidence in evidence_rows:
        span_id = UUID(str(evidence["id"]))
        span_text = str(evidence["span_text"] or body)
        evidence_facts.append(
            {
                "id": str(span_id),
                "text_sha256": hashlib.sha256(span_text.encode()).hexdigest(),
            }
        )
        if span_text.strip():
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=ResourceRef(scheme="evidence_span", id=span_id),
                    text=f"Owned note evidence:\n{span_text}",
                    snapshot=CitationSnapshot(
                        excerpt=span_text[:600],
                        section_label=(
                            str(evidence["citation_label"])
                            if evidence["citation_label"] is not None
                            else None
                        ),
                        result_type="evidence_span",
                        deep_link=f"/notes/{resolved.subject_id}#evidence-{span_id}",
                    ),
                )
            )
    if body.strip() and not candidates:
        candidates.append(
            Candidate(
                index=0,
                target=resolved.ref,
                text=f"Exact atomic note body:\n{body}",
                snapshot=CitationSnapshot(
                    excerpt=body[:600],
                    result_type="note_block",
                    deep_link=f"/notes/{resolved.subject_id}",
                ),
            )
        )
    connection_candidates, connection_refs = one_hop_connection_candidates(
        db,
        viewer_id=viewer_id,
        subject=resolved.ref,
        start_index=len(candidates),
    )
    candidates.extend(connection_candidates)
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "body": body_fingerprint,
                "updated_at": str(note["updated_at"]),
                "evidence": evidence_facts,
                "connections": [
                    {"ref": item.target.uri, "text": item.text} for item in connection_candidates
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return _NoteCollected(
        candidates=candidates,
        manifest=NoteInputManifestV1(
            note_ref=resolved.ref.uri,
            input_fingerprint=fingerprint,
            body_fingerprint=present(body_fingerprint),
            connection_refs=connection_refs,
        ),
        witness_fingerprint=fingerprint,
    )


def _note_owner(db: Session, note_id: UUID) -> UUID:
    owner = db.execute(
        text("SELECT user_id FROM note_blocks WHERE id = :id"),
        {"id": note_id},
    ).scalar_one_or_none()
    if owner is None:
        raise NotFoundError(message="Note not found")
    return UUID(str(owner))


def _audience_user(audience: AudienceScope) -> UUID:
    if not isinstance(audience, AudienceUser):
        raise AssertionError("note dossier audience must be a user")
    return audience.user_id


BINDING = NoteBinding()
POLICY = NoteSubjectPolicy()
