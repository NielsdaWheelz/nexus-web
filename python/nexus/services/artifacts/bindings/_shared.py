"""Shared binding mechanics for Universal Dossiers.

This module owns the two genuinely common pieces of the seven bindings:

* strict, index-grounded synthesis/citation materialization; and
* bounded Media Intelligence aggregation for Library, Podcast, and Contributor.

Subject selection, audience policy, manifests, and ordering remain in the
concrete binding modules.  The generic artifact engine therefore stays free of
subject branches without duplicating the citation and MI fan-out machinery.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.services.artifacts.bindings.base import DossierBindingBase, DossierInputTooLarge
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    DossierBuildFailureCode,
)
from nexus.services.artifacts.manifests import (
    InputManifestV1,
    MediaDisposition,
    MediaManifestEntry,
)
from nexus.services.artifacts.subject_policy import ResolvedSubject
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.media_intelligence import (
    MediaOmission,
    MediaOmissionReason,
    MediaProjection,
    MediaUnit,
    NotReady,
    current_content_fingerprint,
    ensure_current_many,
    get_current,
    media_unit_build_is_suspended,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot, EdgeKind
from nexus.services.structured_synthesis import (
    build_synthesis_prompt,
    build_synthesis_user_content,
    ground_indices,
)

_INPUT_CHAR_BUDGET = 80_000
_MAX_AGGREGATE_MEDIA = 1_000
_AGGREGATE_FANOUT_BUDGET = 8
_EXCERPT_CHARS = 600
_CITATION_ROLES: frozenset[str] = frozenset(("supports", "contradicts", "context"))


@dataclass(frozen=True, slots=True)
class Candidate:
    """One exact resource offered to a synthesis by integer index."""

    index: int
    target: ResourceRef
    text: str
    snapshot: CitationSnapshot


class CitationSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    candidate_index: int
    role: str

    @model_validator(mode="after")
    def _positive_indices(self) -> CitationSelection:
        # Provider Runtime's canonical schema excludes JSON-Schema numeric
        # constraints; enforce these domain bounds after decode instead.
        if self.ordinal < 1 or self.candidate_index < 0:
            raise ValueError("citation ordinal/index out of bounds")
        return self


class StandardSynthesis(BaseModel):
    """The common generated shape used by every non-Media binding."""

    model_config = ConfigDict(extra="forbid")

    content_md: str
    citations: list[CitationSelection]


def synthesis_prompt(subject_label: str) -> str:
    return build_synthesis_prompt(
        persona=(
            "You are a careful research assistant writing a grounded dossier "
            f"about {subject_label}. Every source is offered by integer index."
        ),
        preamble=None,
        domain_rules=[
            "Write content_md as concise, useful markdown synthesis. Base every "
            "claim only on the supplied sources; do not invent facts or quotations.",
            "Place plain inline markers [N] where sources support the prose.",
            "For every marker return one citations entry with the same ordinal, "
            "one supplied candidate_index, and role supports, contradicts, or context.",
        ],
        json_shape=(
            '{"content_md": string, "citations": [{"ordinal": int, '
            '"candidate_index": int, "role": string}]}'
        ),
    )


def synthesis_user_content(
    *,
    candidates: list[Candidate],
    heading: str,
    context: str,
    instruction: str | None,
) -> str:
    rendered = "\n\n".join(f"[{item.index}] {item.text}" for item in candidates)
    extra = context
    if instruction is not None:
        extra = f"{extra}\n\nCUSTOM INSTRUCTION:\n{instruction}"
    return build_synthesis_user_content(
        candidates_header=heading,
        rendered_candidates=rendered,
        extra_user_block=extra,
    )


def materialize_standard(
    decoded_output: BaseModel,
    candidates: list[Candidate],
) -> tuple[str, list[CitationInput]]:
    """Map model indices only to offered candidates; no free-form targets."""

    value = cast("StandardSynthesis", decoded_output)
    pairs = (
        ground_indices(
            value.citations,
            candidates,
            index_of=lambda citation: citation.candidate_index,
            policy="drop",
        )
        or []
    )
    seen: set[int] = set()
    out: list[CitationInput] = []
    for citation, candidate in sorted(pairs, key=lambda pair: pair[0].ordinal):
        if citation.ordinal in seen:
            continue
        seen.add(citation.ordinal)
        role = cast("EdgeKind", citation.role) if citation.role in _CITATION_ROLES else "context"
        out.append(
            CitationInput(
                target=candidate.target,
                ordinal=citation.ordinal,
                kind=role,
                snapshot=candidate.snapshot,
            )
        )
    return value.content_md, out


@dataclass(frozen=True, slots=True)
class AggregateCollected:
    manifest: InputManifestV1
    candidates: list[Candidate]
    media_fingerprints: tuple[tuple[UUID, str], ...]
    media_ids: tuple[UUID, ...]
    subject_context: str
    summaries: tuple[str, ...]
    dependency_failed: bool


class AggregateDependenciesPending(Exception):
    """At least one required Media Intelligence projection is still building."""


@dataclass(frozen=True, slots=True)
class AggregateWitness:
    media_fingerprints: tuple[tuple[UUID, str], ...]
    media_ids: tuple[UUID, ...]
    candidates: list[Candidate]
    viewer_id: UUID


@dataclass(frozen=True, slots=True)
class AggregateCoverage:
    included: tuple[str, ...]
    omitted: tuple[tuple[str, str], ...]


class AggregateMediaBinding(DossierBindingBase):
    """Common bounded MI reduce for Library, Podcast, and Contributor.

    Concrete bindings provide deterministic subject membership and their typed
    manifest constructor.  ``ensure_current_many`` performs only idempotent,
    non-blocking per-media ensures; this owner never waits on child jobs.
    """

    subject_scheme: str
    llm_operation: BackgroundLlmOperation
    profile: str = "balanced"
    reasoning: ReasoningLevel = "high"
    max_output_tokens: int = 5000
    schema: type[BaseModel] = StandardSynthesis
    system_prompt: str
    candidates_heading: str

    def _media_ids(self, db: Session, resolved: ResolvedSubject, viewer_id: UUID) -> list[UUID]:
        raise NotImplementedError

    def _viewer(self, db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> UUID:
        raise NotImplementedError

    def _manifest(
        self, resolved: ResolvedSubject, entries: list[MediaManifestEntry]
    ) -> InputManifestV1:
        raise NotImplementedError

    def _context(self, db: Session, resolved: ResolvedSubject) -> str:
        raise NotImplementedError

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,  # noqa: ARG002 - MI ensures are durable/non-blocking
    ) -> AggregateCollected:
        viewer_id = self._viewer(db, resolved, audience)
        media_ids = list(dict.fromkeys(self._media_ids(db, resolved, viewer_id)))
        if len(media_ids) > _MAX_AGGREGATE_MEDIA:
            raise DossierInputTooLarge
        ensured = ensure_current_many(
            db,
            media_ids=media_ids,
            requester_user_id=viewer_id,
            max_concurrency=_AGGREGATE_FANOUT_BUDGET,
        )
        by_id = {item.media_id: item for item in ensured}
        titles = _media_titles(db, media_ids)
        entries: list[MediaManifestEntry] = []
        candidates: list[Candidate] = []
        fingerprints: list[tuple[UUID, str]] = []
        summaries: list[str] = []
        dependency_failed = False
        used_chars = 0

        for media_id in media_ids:
            item = by_id[media_id]
            fingerprint = current_content_fingerprint(db, media_id=media_id)
            fingerprints.append((media_id, fingerprint))
            disposition = _disposition(item)
            if isinstance(item, MediaOmission):
                dependency_failed = (
                    dependency_failed
                    or item.reason is MediaOmissionReason.ProjectionFailed
                    or item.reason is MediaOmissionReason.ProjectionSuspended
                )
                entries.append(
                    MediaManifestEntry(
                        media_ref=ResourceRef(scheme="media", id=media_id).uri,
                        content_fingerprint=fingerprint,
                        disposition=disposition,
                    )
                )
                continue

            unit = get_current(db, media_id=media_id)
            if not isinstance(unit, MediaUnit) or not unit.claims:
                entries.append(
                    MediaManifestEntry(
                        media_ref=ResourceRef(scheme="media", id=media_id).uri,
                        content_fingerprint=fingerprint,
                        disposition=MediaDisposition.OmittedNoReadyUnit,
                    )
                )
                continue
            span_rows = _span_rows(db, [claim.evidence_span_id for claim in unit.claims])
            pending: list[Candidate] = []
            pending_chars = 0
            for claim in unit.claims:
                span = span_rows.get(claim.evidence_span_id)
                if span is None:
                    continue
                excerpt, section = span
                text_value = f"{titles.get(media_id, 'Untitled')}: {claim.claim_text}"
                pending_chars += len(text_value) + len(excerpt)
                pending.append(
                    Candidate(
                        index=-1,
                        target=ResourceRef(scheme="evidence_span", id=claim.evidence_span_id),
                        text=text_value,
                        snapshot=CitationSnapshot(
                            title=titles.get(media_id),
                            excerpt=excerpt[:_EXCERPT_CHARS],
                            section_label=section,
                            result_type="evidence_span",
                            deep_link=f"/media/{media_id}#evidence-{claim.evidence_span_id}",
                        ),
                    )
                )
            if not pending:
                entries.append(
                    MediaManifestEntry(
                        media_ref=ResourceRef(scheme="media", id=media_id).uri,
                        content_fingerprint=fingerprint,
                        disposition=MediaDisposition.OmittedNoReadyUnit,
                    )
                )
                continue
            if candidates and used_chars + pending_chars > _INPUT_CHAR_BUDGET:
                entries.append(
                    MediaManifestEntry(
                        media_ref=ResourceRef(scheme="media", id=media_id).uri,
                        content_fingerprint=fingerprint,
                        disposition=MediaDisposition.OmittedBudget,
                    )
                )
                continue
            for candidate in pending:
                candidates.append(
                    Candidate(
                        index=len(candidates),
                        target=candidate.target,
                        text=candidate.text,
                        snapshot=candidate.snapshot,
                    )
                )
            used_chars += pending_chars
            summaries.append(f"{titles.get(media_id, 'Untitled')}: {unit.summary_md}")
            entries.append(
                MediaManifestEntry(
                    media_ref=ResourceRef(scheme="media", id=media_id).uri,
                    content_fingerprint=fingerprint,
                    disposition=MediaDisposition.Included,
                )
            )

        if any(
            isinstance(item, MediaOmission)
            and item.reason is MediaOmissionReason.ProjectionPending
            for item in ensured
        ):
            raise AggregateDependenciesPending

        return AggregateCollected(
            manifest=self._manifest(resolved, entries),
            candidates=candidates,
            media_fingerprints=tuple(fingerprints),
            media_ids=tuple(media_ids),
            subject_context=self._context(db, resolved),
            summaries=tuple(summaries),
            dependency_failed=dependency_failed,
        )

    def empty_failure(self, collected: AggregateCollected) -> DossierBuildFailureCode | None:
        if not collected.candidates:
            return DossierBuildFailureCode.NoSourceMaterial
        if collected.dependency_failed:
            return DossierBuildFailureCode.DependencyProjectionFailed
        return None

    def build_user_content(self, collected: AggregateCollected, instruction: str | None) -> str:
        return synthesis_user_content(
            candidates=collected.candidates,
            heading=self.candidates_heading,
            context="\n\n".join((collected.subject_context, *collected.summaries)),
            instruction=instruction,
        )

    def validation_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        collected: AggregateCollected,
    ) -> AggregateWitness:
        return AggregateWitness(
            media_fingerprints=collected.media_fingerprints,
            media_ids=collected.media_ids,
            candidates=collected.candidates,
            viewer_id=self._viewer(db, resolved, audience),
        )

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: AggregateWitness,
    ) -> bool:
        viewer_id = self._viewer(db, resolved, audience)
        if viewer_id != witness.viewer_id:
            return False
        current_ids = tuple(dict.fromkeys(self._media_ids(db, resolved, viewer_id)))
        if current_ids != witness.media_ids:
            return False
        if any(
            not can_read_media(db, viewer_id, media_id)
            or current_content_fingerprint(db, media_id=media_id) != fingerprint
            for media_id, fingerprint in witness.media_fingerprints
        ):
            return False
        span_ids = [
            candidate.target.id
            for candidate in witness.candidates
            if candidate.target.scheme == "evidence_span"
        ]
        return _all_evidence_spans_exist(db, span_ids)

    def materialize(
        self,
        collected: AggregateCollected,  # noqa: ARG002
        decoded_output: BaseModel,
        witness: AggregateWitness,
    ) -> tuple[str, list[CitationInput]]:
        return materialize_standard(decoded_output, witness.candidates)

    def input_manifest(self, collected: AggregateCollected) -> InputManifestV1:
        return collected.manifest

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        viewer_id = self._viewer(db, resolved, audience)
        entries: list[MediaManifestEntry] = []
        media_ids = list(dict.fromkeys(self._media_ids(db, resolved, viewer_id)))
        if len(media_ids) > _MAX_AGGREGATE_MEDIA:
            raise DossierInputTooLarge
        for index, media_id in enumerate(media_ids):
            fingerprint = current_content_fingerprint(db, media_id=media_id)
            if index >= _AGGREGATE_FANOUT_BUDGET:
                disposition = MediaDisposition.OmittedBudget
            elif not can_read_media(db, viewer_id, media_id):
                disposition = MediaDisposition.OmittedNotAudienceVisible
            else:
                unit = get_current(db, media_id=media_id)
                if isinstance(unit, MediaUnit) and unit.claims:
                    disposition = MediaDisposition.Included
                elif unit is NotReady.Failed:
                    disposition = MediaDisposition.OmittedProjectionFailed
                elif unit is NotReady.Building and media_unit_build_is_suspended(
                    db,
                    media_id=media_id,
                    content_fingerprint=fingerprint,
                ):
                    disposition = MediaDisposition.OmittedProjectionFailed
                else:
                    disposition = MediaDisposition.OmittedNoReadyUnit
            entries.append(
                MediaManifestEntry(
                    media_ref=ResourceRef(scheme="media", id=media_id).uri,
                    content_fingerprint=fingerprint,
                    disposition=disposition,
                )
            )
        return self._manifest(resolved, entries)

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        return type(stored) is type(live) and stored.model_dump(mode="json") == live.model_dump(
            mode="json"
        )

    def coverage(self, manifest: InputManifestV1) -> AggregateCoverage:
        entries = _aggregate_manifest_entries(manifest)
        return AggregateCoverage(
            included=tuple(
                entry.media_ref
                for entry in entries
                if entry.disposition is MediaDisposition.Included
            ),
            omitted=tuple(
                (entry.media_ref, entry.disposition.value)
                for entry in entries
                if entry.disposition is not MediaDisposition.Included
            ),
        )


def _disposition(item: MediaProjection | MediaOmission) -> MediaDisposition:
    if isinstance(item, MediaProjection):
        return MediaDisposition.Included
    return {
        MediaOmissionReason.NotAudienceVisible: MediaDisposition.OmittedNotAudienceVisible,
        MediaOmissionReason.NoReadyUnit: MediaDisposition.OmittedNoReadyUnit,
        MediaOmissionReason.ProjectionPending: MediaDisposition.OmittedNoReadyUnit,
        MediaOmissionReason.ProjectionFailed: MediaDisposition.OmittedProjectionFailed,
        MediaOmissionReason.ProjectionSuspended: MediaDisposition.OmittedProjectionFailed,
        MediaOmissionReason.Budget: MediaDisposition.OmittedBudget,
    }[item.reason]


def _aggregate_manifest_entries(manifest: InputManifestV1) -> list[MediaManifestEntry]:
    for field_name in ("media", "episodes", "works"):
        value = getattr(manifest, field_name, None)
        if isinstance(value, list):
            return cast("list[MediaManifestEntry]", value)
    raise AssertionError("aggregate coverage requires an aggregate manifest")


def _media_titles(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    if not media_ids:
        return {}
    return {
        UUID(str(row[0])): str(row[1])
        for row in db.execute(
            text("SELECT id, title FROM media WHERE id = ANY(:ids)"),
            {"ids": media_ids},
        )
    }


def _span_rows(db: Session, span_ids: list[UUID]) -> dict[UUID, tuple[str, str | None]]:
    if not span_ids:
        return {}
    return {
        UUID(str(row[0])): (str(row[1] or ""), str(row[2]) if row[2] else None)
        for row in db.execute(
            text("SELECT id, span_text, citation_label FROM evidence_spans WHERE id = ANY(:ids)"),
            {"ids": span_ids},
        )
    }


def _all_evidence_spans_exist(db: Session, ids: list[UUID]) -> bool:
    if not ids:
        return True
    found = db.execute(
        text("SELECT count(*) FROM evidence_spans WHERE id = ANY(:ids)"),
        {"ids": list(dict.fromkeys(ids))},
    ).scalar_one()
    return int(found) == len(set(ids))
