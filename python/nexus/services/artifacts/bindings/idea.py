"""User-owned Idea Dossier policy and bounded research binding."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.artifacts.bindings._shared import (
    StandardSynthesis,
    materialize_standard,
    synthesis_prompt,
    synthesis_user_content,
)
from nexus.services.artifacts.bindings.base import (
    DossierBindingBase,
    MaterializedDossier,
)
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    AudienceUser,
    DossierBuildFailureCode,
    DossierSubjectLocator,
    InvalidSubjectLocator,
)
from nexus.services.artifacts.idea_seeds import (
    get_idea_subject,
    list_idea_seed_highlight_ids,
)
from nexus.services.artifacts.manifests import (
    IdeaIncludedSource,
    IdeaInputManifestV1,
    IdeaOmittedSource,
    InputManifestV1,
)
from nexus.services.artifacts.research import (
    FrozenIdeaEvidence,
    collect_idea_evidence,
    current_research_source_fingerprint,
    evidence_is_current,
)
from nexus.services.artifacts.subject_policy import (
    ResolvedIdeaSubject,
    ResolvedSubject,
)
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)


@dataclass(frozen=True, slots=True)
class IdeaCoverage:
    seed_count: int
    nexus_source_count: int
    web_source_count: int
    omitted_sources: list[tuple[str, str]]


class IdeaBinding(DossierBindingBase):
    subject_scheme: str = "idea"
    llm_operation: BackgroundLlmOperation = "dossier_idea"
    profile: str = "balanced"
    reasoning: ReasoningLevel = "high"
    max_output_tokens: int = 12_000
    schema: type[BaseModel] = StandardSynthesis
    system_prompt: str = synthesis_prompt(
        "one user-owned idea, grounded in its Nexus contexts and bounded Web research"
    )

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: DossierBuildRuntime,
    ) -> FrozenIdeaEvidence:
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        return await collect_idea_evidence(db, resolved=idea, runtime=runtime)

    def empty_failure(
        self,
        collected: FrozenIdeaEvidence,
    ) -> DossierBuildFailureCode | None:
        return DossierBuildFailureCode.NoSourceMaterial if not collected.sources else None

    def build_user_content(
        self,
        collected: FrozenIdeaEvidence,
        instruction: str | None,
    ) -> str:
        return synthesis_user_content(
            candidates=collected.candidates,
            heading="IDEA CONTEXTS AND RESEARCH SOURCES",
            context=(
                "Teach one coherent idea from foundations through practical examples. "
                "The highlighted seeds establish user context; Nexus and Web Article "
                "sources provide broader evidence. Omitted sources are not evidence."
            ),
            instruction=instruction,
        )

    def validation_witness(
        self,
        db: Session,  # noqa: ARG002
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,  # noqa: ARG002
        collected: FrozenIdeaEvidence,
    ) -> FrozenIdeaEvidence:
        return collected

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: FrozenIdeaEvidence,
    ) -> bool:
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        return evidence_is_current(db, viewer_id=idea.user_id, evidence=witness)

    def materialize(
        self,
        collected: FrozenIdeaEvidence,  # noqa: ARG002
        decoded_output: BaseModel,
        witness: FrozenIdeaEvidence,
    ) -> MaterializedDossier:
        return materialize_standard(decoded_output, witness.candidates)

    def input_manifest(self, collected: FrozenIdeaEvidence) -> InputManifestV1:
        return IdeaInputManifestV1(
            idea_subject_id=str(collected.idea_subject_id),
            included_seed_refs=list(collected.included_seed_refs),
            nexus_query_fingerprints=list(collected.nexus_query_fingerprints),
            web_query_fingerprints=list(collected.web_query_fingerprints),
            included_sources=[
                IdeaIncludedSource(
                    ref=source.read_ref.uri,
                    content_fingerprint=source.content_fingerprint,
                    role=source.role,
                )
                for source in collected.sources
            ],
            omitted_sources=[
                IdeaOmittedSource(locator=item.locator, reason=item.reason)
                for item in collected.omissions
            ],
        )

    def live_manifest(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
    ) -> InputManifestV1:
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        stored = _current_manifest(db, idea=idea)
        refreshed: list[IdeaIncludedSource] = []
        for source in stored.included_sources:
            ref = _parse_ref(source.ref)
            fingerprint = current_research_source_fingerprint(
                db,
                viewer_id=idea.user_id,
                ref=ref,
            )
            refreshed.append(
                source.model_copy(
                    update={
                        # A SHA-256 fingerprint is never empty, so disappearance
                        # deterministically differs without inventing a fallback.
                        "content_fingerprint": fingerprint or "",
                    }
                )
            )
        return stored.model_copy(update={"included_sources": refreshed})

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        return isinstance(stored, IdeaInputManifestV1) and stored == live

    def coverage(self, manifest: InputManifestV1) -> IdeaCoverage:
        if not isinstance(manifest, IdeaInputManifestV1):
            raise AssertionError("Idea coverage requires an Idea manifest")
        return IdeaCoverage(
            seed_count=sum(source.role == "seed" for source in manifest.included_sources),
            nexus_source_count=sum(source.role == "nexus" for source in manifest.included_sources),
            web_source_count=sum(source.role == "web" for source in manifest.included_sources),
            omitted_sources=[
                (source.locator, source.reason) for source in manifest.omitted_sources
            ],
        )


class IdeaSubjectPolicy:
    """Idea heads are entered only through Learn/by-ref, never a subject locator."""

    subject_scheme: str = "idea"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        del subject_handle
        raise InvalidSubjectLocator()

    def resolve_locator(
        self,
        db: Session,
        locator: DossierSubjectLocator,
        requester_user_id: UUID,
    ) -> ResolvedSubject:
        del db, locator, requester_user_id
        raise InvalidSubjectLocator()

    def authorize_read(
        self,
        db: Session,
        resolved: ResolvedSubject,
        requester_user_id: UUID,
    ) -> None:
        idea = _require_idea(resolved)
        if (
            requester_user_id != idea.user_id
            or get_idea_subject(
                db,
                user_id=requester_user_id,
                idea_subject_id=idea.subject_id,
            )
            is None
        ):
            raise NotFoundError(message="Dossier not found")

    authorize_generate = authorize_read

    def derive_audience(
        self,
        resolved: ResolvedSubject,
        requester_user_id: UUID,
    ) -> AudienceScope:
        idea = _require_idea(resolved)
        if requester_user_id != idea.user_id:
            raise NotFoundError(message="Dossier not found")
        return AudienceUser(user_id=idea.user_id)

    def collection_viewer(
        self,
        resolved: ResolvedSubject,
        audience: AudienceScope,
    ) -> UUID | None:
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        return idea.user_id

    def requester_billing(
        self,
        resolved: ResolvedSubject,
        requester_user_id: UUID,
    ) -> UUID:
        idea = _require_idea(resolved)
        if requester_user_id != idea.user_id:
            raise NotFoundError(message="Dossier not found")
        return requester_user_id

    def citation_owner(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
    ) -> UUID:
        del db
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        return idea.user_id

    def audience_visible_source_intersection(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
    ) -> list[ResourceRef]:
        idea = _require_idea(resolved)
        _require_idea_audience(idea, audience)
        return [
            ResourceRef(scheme="highlight", id=highlight_id)
            for highlight_id in list_idea_seed_highlight_ids(
                db,
                artifact_id=_artifact_id(db, idea=idea),
            )
        ]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        del db, ref
        raise AssertionError("Idea subjects have no Resource activation")


def _require_idea(resolved: ResolvedSubject) -> ResolvedIdeaSubject:
    if not isinstance(resolved, ResolvedIdeaSubject):
        raise AssertionError("Idea binding received a Resource subject")
    return resolved


def _require_idea_audience(
    resolved: ResolvedIdeaSubject,
    audience: AudienceScope,
) -> None:
    if not isinstance(audience, AudienceUser) or audience.user_id != resolved.user_id:
        raise AssertionError("Idea Dossier audience must be its owning user")


def _artifact_id(db: Session, *, idea: ResolvedIdeaSubject) -> UUID:
    artifact_id = db.execute(
        text(
            "SELECT id FROM artifacts "
            "WHERE subject_scheme = 'idea' AND subject_id = :subject_id "
            "AND audience_scheme = 'user' AND audience_id = :audience_id"
        ),
        {"subject_id": idea.subject_id, "audience_id": str(idea.user_id)},
    ).scalar_one_or_none()
    if artifact_id is None:
        raise NotFoundError(message="Dossier not found")
    return UUID(str(artifact_id))


def _current_manifest(
    db: Session,
    *,
    idea: ResolvedIdeaSubject,
) -> IdeaInputManifestV1:
    raw = db.execute(
        text(
            "SELECT r.input_manifest FROM artifacts a "
            "JOIN artifact_revisions r ON r.id = a.current_revision_id "
            "WHERE a.subject_scheme = 'idea' AND a.subject_id = :subject_id "
            "AND a.audience_scheme = 'user' AND a.audience_id = :audience_id"
        ),
        {"subject_id": idea.subject_id, "audience_id": str(idea.user_id)},
    ).scalar_one_or_none()
    if not isinstance(raw, dict):
        raise NotFoundError(message="Dossier not found")
    return IdeaInputManifestV1.model_validate(raw)


def _parse_ref(uri: str) -> ResourceRef:
    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        raise AssertionError("persisted Idea manifest has malformed ResourceRef")
    return parsed


BINDING = IdeaBinding()
POLICY = IdeaSubjectPolicy()
