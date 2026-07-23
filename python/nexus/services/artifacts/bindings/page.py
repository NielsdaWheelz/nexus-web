"""Page Dossier policy and ordered-block/Connection binding."""

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
from nexus.services.artifacts.manifests import InputManifestV1, PageInputManifestV1
from nexus.services.artifacts.subject_policy import ResolvedSubject, decode_resource_locator
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.adjacency import load_page_surface
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot

_MAX_BLOCKS = 1_000
_INPUT_CHAR_BUDGET = 80_000


@dataclass(frozen=True, slots=True)
class _PageCollected:
    candidates: list[Candidate]
    manifest: PageInputManifestV1
    witness_fingerprint: str
    title: str


@dataclass(frozen=True, slots=True)
class _PageWitness:
    candidates: list[Candidate]
    fingerprint: str


@dataclass(frozen=True, slots=True)
class PageCoverage:
    block_refs: tuple[str, ...]
    connection_refs: tuple[str, ...]


class PageBinding(DossierBindingBase):
    subject_scheme: str = "page"
    llm_operation: BackgroundLlmOperation = "dossier_page"
    profile: str = "fast"
    reasoning: ReasoningLevel = "low"
    max_output_tokens: int = 3500
    schema: type[BaseModel] = StandardSynthesis
    system_prompt: str = synthesis_prompt("a note page and its current connections")

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,  # noqa: ARG002
    ) -> _PageCollected:
        return _collect(db, resolved, audience)

    def empty_failure(self, collected: _PageCollected) -> DossierBuildFailureCode | None:
        return DossierBuildFailureCode.NoSourceMaterial if not collected.candidates else None

    def build_user_content(self, collected: _PageCollected, instruction: str | None) -> str:
        return synthesis_user_content(
            candidates=collected.candidates,
            heading="ORDERED NOTE BLOCKS AND ONE-HOP CONNECTIONS",
            context=f"PAGE: {collected.title}",
            instruction=instruction,
        )

    def validation_witness(
        self,
        db: Session,  # noqa: ARG002
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,  # noqa: ARG002
        collected: _PageCollected,
    ) -> _PageWitness:
        return _PageWitness(
            candidates=collected.candidates,
            fingerprint=collected.witness_fingerprint,
        )

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: _PageWitness,
    ) -> bool:
        return _collect(db, resolved, audience).witness_fingerprint == witness.fingerprint

    def materialize(
        self,
        collected: _PageCollected,  # noqa: ARG002
        decoded_output: BaseModel,
        witness: _PageWitness,
    ) -> tuple[str, list[CitationInput]]:
        return materialize_standard(decoded_output, witness.candidates)

    def input_manifest(self, collected: _PageCollected) -> InputManifestV1:
        return collected.manifest

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        return _collect(db, resolved, audience).manifest

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        return isinstance(stored, PageInputManifestV1) and stored == live

    def coverage(self, manifest: InputManifestV1) -> PageCoverage:
        if not isinstance(manifest, PageInputManifestV1):
            raise AssertionError("page coverage requires page manifest")
        return PageCoverage(
            block_refs=tuple(manifest.block_refs),
            connection_refs=tuple(manifest.connection_refs),
        )


class PageSubjectPolicy:
    subject_scheme: str = "page"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="page",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "page":
            raise InvalidSubjectLocator()
        owner_id = _page_owner(db, locator.ref.id)
        if owner_id != requester_user_id:
            raise NotFoundError(message="Page not found")
        return ResolvedSubject(
            scheme="page",
            subject_id=locator.ref.id,
            ref=locator.ref,
            detail=owner_id,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if _page_owner(db, resolved.subject_id) != requester_user_id:
            raise NotFoundError(message="Page not found")

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        owner = resolved.detail
        if not isinstance(owner, UUID):
            raise AssertionError("resolved page must carry its owner")
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
            href=f"/pages/{ref.id}",
            unresolved_reason=None,
        )


def _collect(db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> _PageCollected:
    viewer_id = _audience_user(audience)
    surface = load_page_surface(
        db,
        user_id=viewer_id,
        page_id=resolved.subject_id,
    )
    block_rows: list[dict[str, str]] = []
    candidates: list[Candidate] = []
    used_chars = 0

    def walk(nodes) -> None:  # noqa: ANN001 - recursive PageSurface nodes
        nonlocal used_chars
        for node in nodes:
            body = node.block.body_text
            if len(block_rows) >= _MAX_BLOCKS or used_chars + len(body) > _INPUT_CHAR_BUDGET:
                raise DossierInputTooLarge
            used_chars += len(body)
            block_ref = ResourceRef(scheme="note_block", id=node.block.id)
            block_rows.append(
                {
                    "ref": block_ref.uri,
                    "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
                    "order_key": node.source_order_key,
                    "updated_at": str(node.block.updated_at),
                }
            )
            if body.strip():
                candidates.append(
                    Candidate(
                        index=len(candidates),
                        target=block_ref,
                        text=f"Contained note block ({node.source_order_key}):\n{body}",
                        snapshot=CitationSnapshot(
                            title=surface.page.title,
                            excerpt=body[:600],
                            result_type="note_block",
                            deep_link=f"/notes/{node.block.id}",
                        ),
                    )
                )
            walk(node.children)

    walk(surface.roots)
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
                "title": surface.page.title,
                "page_updated_at": str(surface.page.updated_at),
                "blocks": block_rows,
                "connections": [
                    {"ref": item.target.uri, "text": item.text} for item in connection_candidates
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return _PageCollected(
        candidates=candidates,
        manifest=PageInputManifestV1(
            page_ref=resolved.ref.uri,
            input_fingerprint=fingerprint,
            block_refs=[row["ref"] for row in block_rows],
            connection_refs=connection_refs,
        ),
        witness_fingerprint=fingerprint,
        title=surface.page.title,
    )


def _page_owner(db: Session, page_id: UUID) -> UUID:
    owner = db.execute(
        text("SELECT user_id FROM pages WHERE id = :id"),
        {"id": page_id},
    ).scalar_one_or_none()
    if owner is None:
        raise NotFoundError(message="Page not found")
    return UUID(str(owner))


def _audience_user(audience: AudienceScope) -> UUID:
    if not isinstance(audience, AudienceUser):
        raise AssertionError("page dossier audience must be a user")
    return audience.user_id


BINDING = PageBinding()
POLICY = PageSubjectPolicy()
