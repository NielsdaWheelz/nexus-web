"""The Media dossier binding + subject policy (CP3-SINGLE, A2/A4/A11/A18/A20).

A *media dossier* is a grounded synthesis of ONE document, built from its current
Media Intelligence unit (:mod:`nexus.services.media_intelligence`): the unit's
summary plus its grounded claims, each claim bound to an exact ``evidence_span``.
Those evidence spans are the only citation candidates — the model cites a claim by
integer index and each citation materializes to its span (A10). A media whose unit
is not ready, or is ready-but-claimless, has no usable input and fails
``NoSourceMaterial`` before any dispatch (A11 §543).

Audience is always the requesting user (A2): a media dossier is a private,
per-user reading of a document. Identity/authz/audience/activation live in
:data:`POLICY`; the generation pipeline (collect → reduce → materialize → manifest)
lives in :data:`BINDING`. The generic engine drives both with zero scheme branches.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import NotFoundError
from nexus.schemas.artifact import (
    MediaAbstractBuildingOut,
    MediaAbstractFailedOut,
    MediaAbstractNotAvailableOut,
    MediaAbstractOut,
    MediaAbstractReadyOut,
    MediaAbstractStaleOut,
)
from nexus.schemas.presence import Presence, present
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.artifacts.bindings.base import DossierBindingBase
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    AudienceUser,
    DossierBuildFailureCode,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectResource,
)
from nexus.services.artifacts.manifests import (
    EvidenceOmission,
    InputManifestV1,
    MediaInputManifestV1,
)
from nexus.services.artifacts.subject_policy import ResolvedSubject, decode_resource_locator
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.media_intelligence import (
    MediaUnit,
    current_content_fingerprint,
    get_current,
    read_single,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot, EdgeKind
from nexus.services.structured_synthesis import (
    build_synthesis_prompt,
    build_synthesis_user_content,
    ground_indices,
)

MEDIA_DOSSIER_MAX_OUTPUT_TOKENS = 4000
# Budget the offered claim context in characters (~4 chars/token); claims past the
# budget are dropped and recorded as omitted evidence (coverage, A18) rather than
# silently capped.
MEDIA_DOSSIER_INPUT_CHAR_BUDGET = 60_000
_EXCERPT_MAX_CHARS = 600
_CITATION_ROLES: frozenset[str] = frozenset(("supports", "contradicts", "context"))


# ---------------------------------------------------------------------------
# Collected inputs / witness / coverage (opaque to the engine).
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _MediaCandidate:
    """One unit claim offered to the model by integer index; its evidence span is
    the citation target (A10). Snapshot fields are captured here so ``materialize``
    stays pure (no DB)."""

    index: int
    evidence_span_id: UUID
    media_id: UUID
    claim_text: str
    title: str | None
    excerpt: str
    section_label: str | None
    deep_link: str


@dataclass(frozen=True, slots=True)
class _MediaCollected:
    media_id: UUID
    media_ref: str
    content_fingerprint: str
    summary_md: str
    candidates: list[_MediaCandidate]
    omitted_evidence: list[EvidenceOmission] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class _MediaWitness:
    """The offered candidates + the content fingerprint the dossier was built
    against, captured before dispatch for the pre-promotion recheck (A6)."""

    media_id: UUID
    content_fingerprint: str
    candidates: list[_MediaCandidate]


@dataclass(frozen=True, slots=True)
class MediaCoverage:
    """Binding-specific coverage (A18): offered vs omitted evidence."""

    offered_claim_count: int
    omitted_evidence_refs: tuple[str, ...]


# ---------------------------------------------------------------------------
# Generated-output schema (strict JSON) — prose + inline citations by claim index.
# ---------------------------------------------------------------------------


class _MediaCitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    claim_index: int
    role: str


class _MediaSynthesis(BaseModel):
    """The strict-JSON media dossier: synthesis prose plus its inline citations."""

    model_config = ConfigDict(extra="forbid")

    content_md: str
    citations: list[_MediaCitationOut]


_MEDIA_PERSONA = (
    "You are a careful research assistant writing a dossier for one document from "
    "its own grounded claims. Each claim is offered by integer index."
)
_MEDIA_DOMAIN_RULES = [
    "Write content_md: faithful markdown synthesis prose for this single document "
    "— an overview, its key claims and themes, notable tensions, and open "
    "questions. Use prose, not rigid sections. Base every statement only on the "
    "provided summary and claims; do not invent passages, indices, or quotations.",
    "Place inline citation markers [N] in the prose where a claim supports the "
    "statement, where N is the ordinal you assign in citations.",
    "Write citations: for each [N], one entry {ordinal:N, claim_index:int, "
    "role:'supports'|'contradicts'|'context'} where claim_index is the integer "
    "index of the single provided claim it cites. Never cite an index you were "
    "not given.",
]
_MEDIA_JSON_SHAPE = (
    '{"content_md": string, "citations": [{"ordinal": int, "claim_index": int, "role": string}]}'
)
_MEDIA_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=_MEDIA_PERSONA,
    preamble=None,
    domain_rules=_MEDIA_DOMAIN_RULES,
    json_shape=_MEDIA_JSON_SHAPE,
)


def _coerce_role(role: str) -> EdgeKind:
    return cast("EdgeKind", role) if role in _CITATION_ROLES else "context"


def _viewer(audience: AudienceScope) -> UUID:
    if not isinstance(audience, AudienceUser):
        # justify-defect: media dossiers are always keyed to a User audience (A2);
        # a Library audience for a media subject is an integrator misconfiguration.
        raise AssertionError("media dossier audience must be a user audience")
    return audience.user_id


# ---------------------------------------------------------------------------
# Binding.
# ---------------------------------------------------------------------------


class MediaBinding(DossierBindingBase):
    """The ``media`` generation pipeline (A20). One synthesis over the document's
    own MI unit; citations are the unit's evidence spans."""

    subject_scheme: str = "media"
    llm_operation: BackgroundLlmOperation = "dossier_media"
    profile: str = "balanced"
    reasoning: ReasoningLevel = "medium"
    max_output_tokens: int = MEDIA_DOSSIER_MAX_OUTPUT_TOKENS
    system_prompt: str = _MEDIA_SYSTEM_PROMPT
    schema: type[BaseModel] = _MediaSynthesis

    def media_abstract(
        self,
        db: Session,
        *,
        subject_id: UUID,
        requester_user_id: UUID,
    ) -> Presence[MediaAbstractOut]:
        projection = read_single(
            db,
            media_id=subject_id,
            requester_user_id=requester_user_id,
        )
        if projection.status == "building":
            abstract: MediaAbstractOut = MediaAbstractBuildingOut()
        elif projection.status == "ready":
            if projection.summary_md is None:
                raise AssertionError("ready Media Intelligence projection has no summary")
            abstract = MediaAbstractReadyOut(summary_md=projection.summary_md)
        elif projection.status == "stale":
            abstract = MediaAbstractStaleOut(summary_md=projection.summary_md or "")
        elif projection.status == "failed":
            abstract = MediaAbstractFailedOut()
        else:
            abstract = MediaAbstractNotAvailableOut()
        return present(abstract)

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,  # noqa: ARG002 - single media reads never dispatch MI
    ) -> _MediaCollected:
        """Read the current MI unit for this document and offer its claims + spans.

        Media is a single-subject binding: it READS the current unit (it never
        ensures/builds — that is the aggregate bindings' job) and never fans out.
        An unreadable / not-ready / claimless media yields no candidates, which
        ``empty_failure`` turns into ``NoSourceMaterial`` (A11 §543)."""
        media_id = resolved.subject_id
        media_ref = resolved.ref.uri
        viewer = _viewer(audience)
        try:
            projection = read_single(db, media_id=media_id, requester_user_id=viewer)
        except NotFoundError:
            # Audience-invisible now: no usable input (recheck would call it
            # InputsChanged; pre-dispatch it is simply empty → NoSourceMaterial).
            return _MediaCollected(
                media_id=media_id,
                media_ref=media_ref,
                content_fingerprint=current_content_fingerprint(db, media_id=media_id),
                summary_md="",
                candidates=[],
            )
        if projection.status != "ready":
            return _MediaCollected(
                media_id=media_id,
                media_ref=media_ref,
                content_fingerprint=projection.content_fingerprint,
                summary_md="",
                candidates=[],
            )
        unit = get_current(db, media_id=media_id)
        if not isinstance(unit, MediaUnit) or not unit.claims:
            return _MediaCollected(
                media_id=media_id,
                media_ref=media_ref,
                content_fingerprint=projection.content_fingerprint,
                summary_md="",
                candidates=[],
            )

        span_map = _load_span_texts(db, [claim.evidence_span_id for claim in unit.claims])
        title = _media_title(db, media_id=media_id)
        candidates: list[_MediaCandidate] = []
        omitted: list[EvidenceOmission] = []
        used_chars = 0
        for claim in unit.claims:
            span_ref = ResourceRef(scheme="evidence_span", id=claim.evidence_span_id).uri
            span = span_map.get(claim.evidence_span_id)
            if span is None:
                omitted.append(EvidenceOmission(evidence_ref=span_ref))
                continue
            span_text, section_label = span
            excerpt = (span_text or claim.claim_text)[:_EXCERPT_MAX_CHARS]
            cost = len(claim.claim_text) + len(excerpt)
            if candidates and used_chars + cost > MEDIA_DOSSIER_INPUT_CHAR_BUDGET:
                omitted.append(EvidenceOmission(evidence_ref=span_ref))
                continue
            used_chars += cost
            candidates.append(
                _MediaCandidate(
                    index=len(candidates),
                    evidence_span_id=claim.evidence_span_id,
                    media_id=media_id,
                    claim_text=claim.claim_text,
                    title=title,
                    excerpt=excerpt,
                    section_label=section_label,
                    deep_link=f"/media/{media_id}#evidence-{claim.evidence_span_id}",
                )
            )
        return _MediaCollected(
            media_id=media_id,
            media_ref=media_ref,
            content_fingerprint=unit.content_fingerprint,
            summary_md=unit.summary_md,
            candidates=candidates,
            omitted_evidence=omitted,
        )

    def empty_failure(self, collected: _MediaCollected) -> DossierBuildFailureCode | None:
        """No usable candidate (not-ready / claimless / invisible) → NoSourceMaterial.

        A single media has no other sources to fall back on, so a missing
        projection is ``NoSourceMaterial``, never ``DependencyProjectionFailed``."""
        if not collected.candidates:
            return DossierBuildFailureCode.NoSourceMaterial
        return None

    def build_user_content(self, collected: _MediaCollected, instruction: str | None) -> str:
        rendered = "\n\n".join(
            f"[{candidate.index}] {candidate.claim_text}" for candidate in collected.candidates
        )
        extra = f"DOCUMENT SUMMARY:\n{collected.summary_md}"
        if instruction is not None:
            extra += f"\n\nCUSTOM INSTRUCTION:\n{instruction}"
        return build_synthesis_user_content(
            candidates_header="DOCUMENT CLAIMS",
            rendered_candidates=rendered,
            extra_user_block=extra,
        )

    def validation_witness(
        self,
        db: Session,  # noqa: ARG002 - candidates are already resolved in collect
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,  # noqa: ARG002
        collected: _MediaCollected,
    ) -> _MediaWitness:
        """Carry the offered candidates + the built-against content fingerprint for
        the pre-promotion recheck (A6). The candidates were resolved for the
        audience in ``collect``; the authoritative recheck happens under the head
        lock in :meth:`recheck_witness`."""
        return _MediaWitness(
            media_id=collected.media_id,
            content_fingerprint=collected.content_fingerprint,
            candidates=collected.candidates,
        )

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,  # noqa: ARG002
        audience: AudienceScope,
        witness: _MediaWitness,
    ) -> bool:
        """Authoritative cheap recheck under the head lock: the media is still
        audience-readable, its content fingerprint is unchanged (no reingestion),
        and every offered evidence span still exists. ``False`` ⇒ InputsChanged."""
        viewer = _viewer(audience)
        if not can_read_media(db, viewer, witness.media_id):
            return False
        if (
            current_content_fingerprint(db, media_id=witness.media_id)
            != witness.content_fingerprint
        ):
            return False
        span_ids = list({candidate.evidence_span_id for candidate in witness.candidates})
        if span_ids:
            found = db.execute(
                text("SELECT COUNT(*) FROM evidence_spans WHERE id = ANY(:ids)"),
                {"ids": span_ids},
            ).scalar_one()
            if int(found) != len(span_ids):
                return False
        return True

    def materialize(
        self,
        collected: _MediaCollected,  # noqa: ARG002 - candidates come from the witness (A10)
        decoded_output: BaseModel,
        witness: _MediaWitness,
    ) -> tuple[str, list[CitationInput]]:
        """Map the model's citation indices onto the witness candidates (A10) — the
        only citation source. Pure: every snapshot field was captured in collect."""
        value = cast("_MediaSynthesis", decoded_output)
        pairs = (
            ground_indices(
                value.citations,
                witness.candidates,
                index_of=lambda citation: citation.claim_index,
                policy="drop",
            )
            or []
        )
        seen_ordinals: set[int] = set()
        citations: list[CitationInput] = []
        for citation, candidate in pairs:
            if citation.ordinal in seen_ordinals:
                continue
            seen_ordinals.add(citation.ordinal)
            citations.append(
                CitationInput(
                    target=ResourceRef(scheme="evidence_span", id=candidate.evidence_span_id),
                    ordinal=citation.ordinal,
                    kind=_coerce_role(citation.role),
                    snapshot=CitationSnapshot(
                        title=candidate.title,
                        excerpt=candidate.excerpt,
                        section_label=candidate.section_label,
                        result_type="evidence_span",
                        deep_link=candidate.deep_link,
                    ),
                )
            )
        return value.content_md, citations

    def input_manifest(self, collected: _MediaCollected) -> InputManifestV1:
        return MediaInputManifestV1(
            media_ref=collected.media_ref,
            content_fingerprint=collected.content_fingerprint,
            offered_claim_count=len(collected.candidates),
            omitted_evidence=list(collected.omitted_evidence),
        )

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        """The live media manifest for freshness (no LLM). Only the content
        fingerprint drives the comparison, so the claim count is best-effort."""
        media_id = resolved.subject_id
        viewer = _viewer(audience)
        fingerprint = current_content_fingerprint(db, media_id=media_id)
        offered = 0
        if can_read_media(db, viewer, media_id):
            unit = get_current(db, media_id=media_id)
            if isinstance(unit, MediaUnit):
                offered = len(unit.claims)
        return MediaInputManifestV1(
            media_ref=resolved.ref.uri,
            content_fingerprint=fingerprint,
            offered_claim_count=offered,
            omitted_evidence=[],
        )

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        """Freshness by content fingerprint (A18): reingestion moves the
        fingerprint → stale."""
        if not isinstance(stored, MediaInputManifestV1) or not isinstance(
            live, MediaInputManifestV1
        ):
            return False
        return stored.content_fingerprint == live.content_fingerprint

    def coverage(self, manifest: InputManifestV1) -> MediaCoverage:
        if not isinstance(manifest, MediaInputManifestV1):
            # justify-defect: the media binding only ever stores a media manifest.
            raise AssertionError("media coverage requires a MediaInputManifestV1")
        return MediaCoverage(
            offered_claim_count=manifest.offered_claim_count,
            omitted_evidence_refs=tuple(
                omission.evidence_ref for omission in manifest.omitted_evidence
            ),
        )


# ---------------------------------------------------------------------------
# Subject policy.
# ---------------------------------------------------------------------------


class MediaSubjectPolicy:
    """The ``media`` identity/authz/audience/activation owner (A2/A3). Audience is
    always the requesting user; every existence-leaking method is 404-masked."""

    subject_scheme: str = "media"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="media",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "media":
            raise InvalidSubjectLocator()
        media_id = locator.ref.id
        if not can_read_media(db, requester_user_id, media_id):
            raise NotFoundError(message="Media not found")
        return ResolvedSubject(
            scheme="media",
            subject_id=media_id,
            ref=ResourceRef(scheme="media", id=media_id),
            detail=None,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if not can_read_media(db, requester_user_id, resolved.subject_id):
            raise NotFoundError(message="Media not found")

    def authorize_generate(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if not can_read_media(db, requester_user_id, resolved.subject_id):
            raise NotFoundError(message="Media not found")

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        return AudienceUser(user_id=requester_user_id)

    def collection_viewer(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID | None:
        return _viewer(audience)

    def requester_billing(self, resolved: ResolvedSubject, requester_user_id: UUID) -> UUID:
        return requester_user_id

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        return _viewer(audience)

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> list[ResourceRef]:
        """The audience-visible candidate sources: the document's own evidence
        spans (empty when the media is no longer readable)."""
        viewer = _viewer(audience)
        if not can_read_media(db, viewer, resolved.subject_id):
            return []
        unit = get_current(db, media_id=resolved.subject_id)
        if not isinstance(unit, MediaUnit):
            return []
        return [
            ResourceRef(scheme="evidence_span", id=claim.evidence_span_id) for claim in unit.claims
        ]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        """Open the media pane (canonical resource activation; href stays non-None
        so citations anchored to the document remain routeable, B6)."""
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="route",
            href=f"/media/{ref.id}",
            unresolved_reason=None,
        )


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _load_span_texts(
    db: Session, span_ids: list[UUID]
) -> dict[UUID, tuple[str | None, str | None]]:
    """Batch-load ``(span_text, citation_label)`` for the unit's evidence spans.

    The spans all belong to this (already audience-readable) media, so a single
    keyed read is sufficient — a span absent from the result was deleted and is
    recorded as omitted evidence by the caller."""
    if not span_ids:
        return {}
    rows = (
        db.execute(
            text("SELECT id, span_text, citation_label FROM evidence_spans WHERE id = ANY(:ids)"),
            {"ids": span_ids},
        )
        .mappings()
        .all()
    )
    return {
        UUID(str(row["id"])): (
            str(row["span_text"]) if row["span_text"] is not None else None,
            str(row["citation_label"]) if row["citation_label"] is not None else None,
        )
        for row in rows
    }


def _media_title(db: Session, *, media_id: UUID) -> str | None:
    title = db.execute(
        text("SELECT title FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one_or_none()
    return str(title) if title is not None else None


BINDING: DossierBinding = MediaBinding()
POLICY: SubjectPolicy = MediaSubjectPolicy()


# Imported here (not at the top) only for the export annotations above; keeping the
# Protocol imports adjacent to the constants they type documents the conformance
# contract this module fills.
from nexus.services.artifacts.bindings.base import DossierBinding  # noqa: E402
from nexus.services.artifacts.subject_policy import SubjectPolicy  # noqa: E402
