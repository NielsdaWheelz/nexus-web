"""Prepare the installed section catalogue independently of its search index.

Admission freezes a source and installed navigation proof. Derivation reads a
verified immutable package outside the write transaction. The family barrier
and exact queue claim fence publication. The witness records completed work.
"""

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, fields
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_serializable
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.errors import ApiError, ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs import queue
from nexus.schemas.imports import WaitingReason
from nexus.schemas.media_parts import PartPrepare
from nexus.schemas.reader_apparatus import NoteRegion
from nexus.schemas.section_preparation import SectionPreparationAdmission, SectionPreparationOut
from nexus.schemas.source_issues import TooManyNotes, UnresolvedNavigationTarget
from nexus.services.content_indexing import reconcile_media_section_bounds, record_section_witness
from nexus.services.epub_ingest import (
    EpubNavigationPlan,
    EpubPlan,
    RetainedEpubFragment,
    derive_epub_navigation,
    derive_retained_epub_apparatus,
    replace_epub_navigation_projection,
)
from nexus.services.epub_structure import EpubStructureSection, EpubStructureTocNode
from nexus.services.media_locks import lock_media_rows_in_order
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
)
from nexus.services.reader_apparatus import (
    ApparatusOutput,
    apparatus_output,
    read_apparatus_output,
    read_note_regions,
    replace_media_apparatus,
    validate_preserved_apparatus_replacement,
)
from nexus.services.reader_navigation import read_media_navigation_proof
from nexus.services.reader_publication import (
    read_publication_generation,
    read_publication_source_issues,
)
from nexus.services.reader_structure import DocumentPoint, DomCut, NavigationProof, SectionProof
from nexus.services.reader_text_slice import (
    SectionFormat,
    section_detector_revision,
    section_witness_key,
)
from nexus.storage.client import get_storage_client

JOB_KIND = "prepare_reader_sections"


class _PreparationJob(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    requester_user_id: UUID
    expected_source_generation: int
    format: SectionFormat
    detector_revision: int
    expected_navigation_key: str


class EpubRepairReview(BaseModel):
    """Private reviewed input and exact desired output for one retained source."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    projection: Literal["navigation", "apparatus"]
    media_id: UUID
    source_generation: int = Field(ge=1)
    source_size_bytes: int = Field(gt=0)
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    fragments_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    navigation_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    note_regions_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    apparatus_sha256: str | None = Field(pattern=r"^[a-f0-9]{64}$")
    plan_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class _Package:
    storage_path: str
    size_bytes: int
    source_sha256: str
    fragments: tuple[RetainedEpubFragment, ...]
    note_regions: list[NoteRegion]

    @property
    def body_key(self) -> str:
        return _digest([asdict(fragment) for fragment in self.fragments])

    @property
    def note_key(self) -> str:
        return _digest(
            sorted(_digest(region.model_dump(mode="json")) for region in self.note_regions)
        )


def _digest(value: object) -> str:
    return sha256(
        json.dumps(
            value, default=str, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def _witness_key(format: SectionFormat, proof: NavigationProof) -> str:
    return section_witness_key(
        format=format, generation=proof.navigation.generation, sections=proof.sections
    )


def _installed_witness(db: Session, media_id: UUID) -> str | None:
    return db.scalar(
        text(
            "SELECT section_witness_key FROM content_index_states WHERE owner_kind='media' AND owner_id=:id"
        ),
        {"id": media_id},
    )


def sections_prepared(db: Session, *, source: Media, proof: NavigationProof) -> bool:
    """The exact installed geometry has a witness from this format's detector."""
    return _installed_witness(db, source.id) == _witness_key(
        cast(SectionFormat, source.kind), proof
    )


def seed_published_section_witness(db: Session, *, media: Media) -> None:
    """Fresh publication already ran the detector. Its index state has been created."""
    from nexus.services.media_parts import part_source_block_reason

    if part_source_block_reason(db, media=media) is not None:
        return
    generation = read_publication_generation(db, media_id=media.id)
    assert generation is not None
    format = cast(SectionFormat, media.kind)
    proof = read_media_navigation_proof(db, media_id=media.id, kind=format, generation=generation)
    record_section_witness(db, media_id=media.id, witness_key=_witness_key(format, proof))


def prepare_media_parts(
    db: Session, *, viewer_id: UUID, source_media_id: UUID, request: PartPrepare
) -> SectionPreparationAdmission:
    """Admit a creator's preparation using the client UUID.

    An identical known request answers its own job. A deliberate retry after a
    terminal failure uses a new UUID. Admission has no search side effects.
    """
    from nexus.services.media_parts import require_part_source_creator

    def admit() -> SectionPreparationAdmission:
        if not lock_media_rows_in_order(db, [source_media_id], lock_mode="no_key_update"):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        source = db.get(Media, source_media_id)
        if source is None or not can_read_media(db, viewer_id, source_media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if source.created_by_user_id != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
        if known := queue.get_job(db, request.id):
            if known.kind != JOB_KIND or any(
                known.payload[key] != value
                for key, value in {
                    "media_id": str(source_media_id),
                    "requester_user_id": str(viewer_id),
                    "expected_source_generation": request.expected_source_generation,
                }.items()
            ):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "The job id belongs to another request."
                )
        else:
            source = require_part_source_creator(
                db, viewer_id=viewer_id, source_media_id=source_media_id
            )
            generation = read_publication_generation(db, media_id=source_media_id)
            if generation is None or generation != request.expected_source_generation:
                raise _changed()
            format = cast(SectionFormat, source.kind)
            proof = read_media_navigation_proof(
                db, media_id=source_media_id, kind=format, generation=generation
            )
            payload = _PreparationJob(
                media_id=source_media_id,
                requester_user_id=viewer_id,
                expected_source_generation=generation,
                format=format,
                detector_revision=section_detector_revision(format),
                expected_navigation_key=proof.key,
            )
            queue.enqueue_job(
                db, kind=JOB_KIND, payload=payload.model_dump(mode="json"), id=request.id
            )
        return SectionPreparationAdmission(media_id=source_media_id, job_id=request.id)

    return retry_serializable(db, "prepare_media_parts", admit)


def _latest_jobs(
    db: Session, sources: Mapping[UUID, tuple[SectionFormat, int]]
) -> dict[UUID, queue.JobRow]:
    if not sources:
        return {}
    jobs = queue.list_jobs_for_payload_values(
        db, kind=JOB_KIND, payload_key="media_id", values=[str(id) for id in sources]
    )
    latest: dict[UUID, queue.JobRow] = {}
    for job in jobs:
        job_input = _PreparationJob.model_validate(job.payload)
        format, generation = sources[job_input.media_id]
        if (
            job_input.format,
            job_input.expected_source_generation,
            job_input.detector_revision,
        ) == (format, generation, section_detector_revision(format)):
            latest.setdefault(job_input.media_id, job)
    return latest


def read_preparation_observations(
    db: Session, *, sources: Mapping[UUID, tuple[SectionFormat, int]]
) -> dict[UUID, tuple[str, bool]]:
    """Observe work without evaluating extraction capability or loading a source body."""
    return {
        id: (f"{job.id}:{job.status}", job.status in ("pending", "failed", "running"))
        for id, job in _latest_jobs(db, sources).items()
    }


def read_preparation(
    db: Session, *, media_id: UUID, format: SectionFormat, generation: int, prepared: bool
) -> SectionPreparationOut | None:
    """A newer preparation or installed witness supersedes an earlier failure."""
    job = _latest_jobs(db, {media_id: (format, generation)}).get(media_id)
    if job is None or (job.result and job.result.get("status") == "superseded"):
        return None
    failed = job.status in ("held", "dead")
    if failed and prepared:
        return None
    waiting: WaitingReason | None = None
    if job.status in ("pending", "failed"):
        now, heavy_job = db.execute(
            text(
                "SELECT now(), job_id FROM background_job_capacity_leases WHERE resource_class='Heavy'"
            )
        ).one()
        waiting = (
            "RetryBackoff"
            if job.available_at > now
            else "Capacity"
            if heavy_job not in (None, job.id)
            else "Queue"
        )
    active = job.status in ("pending", "failed", "running")
    return SectionPreparationOut(
        job_id=job.id,
        classification="Active" if active else "NeedsAttention" if failed else "Complete",
        status=("Processing" if job.status == "running" else "Queued") if active else None,
        waiting_reason=waiting,
        next_retry_at=job.available_at if waiting == "RetryBackoff" else None,
        failure_code=job.error_code if failed else None,
    )


def _changed() -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_READER_CONTENT_CHANGED,
        "The source or its installed projection changed again.",
    )


def _capture_package(db: Session, media_id: UUID) -> _Package:
    storage_path, size_bytes, source_sha256 = db.execute(
        text("SELECT storage_path, size_bytes, source_sha256 FROM media_file WHERE media_id=:id"),
        {"id": media_id},
    ).one()
    fragments = tuple(
        RetainedEpubFragment(
            row.id, row.idx, row.package_href, row.html_sanitized, row.canonical_text
        )
        for row in db.execute(
            text(
                "SELECT f.id, f.idx, s.package_href, f.html_sanitized, f.canonical_text"
                " FROM fragments f JOIN epub_fragment_sources s ON s.fragment_id=f.id AND s.media_id=f.media_id"
                " WHERE f.media_id=:id ORDER BY f.idx"
            ),
            {"id": media_id},
        )
    )
    return _Package(
        storage_path, size_bytes, source_sha256, fragments, read_note_regions(db, media_id)
    )


def _materialize_package(directory: Path, package: _Package) -> Path:
    path = directory / "source.epub"
    try:
        stream_storage_object_to_file(
            get_storage_client(),
            storage_path=package.storage_path,
            destination=path,
            expected_size_bytes=package.size_bytes,
            expected_source_sha256=package.source_sha256,
        )
    except StorageObjectIntegrityError as exc:
        raise ApiError(
            ApiErrorCode.E_SOURCE_INTEGRITY, "Stored EPUB no longer matches its source identity"
        ) from exc
    return path


def _installed_navigation(db: Session, media_id: UUID, generation: int) -> EpubNavigationPlan:
    params = {"id": media_id}
    # Use the same logical fields as the writer, in its persisted order.
    sections = tuple(
        EpubStructureSection(
            row.location_id,
            row.label,
            row.fragment_idx,
            row.href_path,
            row.href_fragment,
            row.start_offset,
            row.parent_section_id,
            None
            if row.end_fragment_idx is None
            else DocumentPoint(row.end_fragment_idx, row.end_offset),
            row.source,
            None
            if row.start_dom_path is None
            else DomCut(tuple(row.start_dom_path), row.start_dom_edge),
            None if row.end_dom_path is None else DomCut(tuple(row.end_dom_path), row.end_dom_edge),
        )
        for row in db.execute(
            text("SELECT * FROM epub_nav_locations WHERE media_id=:id ORDER BY ordinal"), params
        )
    )
    node_columns = ", ".join(field.name for field in fields(EpubStructureTocNode))
    nodes = tuple(
        EpubStructureTocNode(**row)
        for row in db.execute(
            text(f"SELECT {node_columns} FROM epub_toc_nodes WHERE media_id=:id"), params
        ).mappings()
    )
    issues = tuple(
        issue
        for issue in read_publication_source_issues(db, media_id=media_id, generation=generation)
        if isinstance(issue, UnresolvedNavigationTarget)
    )
    return EpubNavigationPlan(sections, nodes, issues)


def _plan_witness(plan: EpubNavigationPlan, generation: int) -> str:
    return section_witness_key(
        format="epub",
        generation=generation,
        sections=[
            SectionProof(
                s.location_id,
                s.label,
                s.parent_section_id,
                DocumentPoint(s.fragment_idx, s.start_offset),
                s.end,
                s.start_cut,
                s.end_cut,
            )
            for s in sorted(plan.sections, key=lambda s: (s.fragment_idx, s.start_offset))
        ],
    )


def _navigation_output(plan: EpubNavigationPlan, witness: str | None) -> dict[str, object]:
    return {
        "sections": [asdict(section) for section in plan.sections],
        "toc_nodes": [
            asdict(node)
            for node in sorted(plan.toc_nodes, key=lambda node: (node.order_key, node.node_id))
        ],
        "navigation_issues": [
            issue.model_dump(mode="json")
            for issue in sorted(plan.navigation_issues, key=lambda issue: issue.node_id)
        ],
        "section_witness_key": witness,
    }


def _install_navigation(
    db: Session,
    media_id: UUID,
    generation: int,
    plan: EpubNavigationPlan,
    witness: str,
    *,
    apparatus_issues: tuple[TooManyNotes, ...] | None = None,
) -> None:
    replace_epub_navigation_projection(
        db,
        media_id=media_id,
        generation=generation,
        plan=plan,
        apparatus_issues=apparatus_issues,
    )
    record_section_witness(db, media_id=media_id, witness_key=witness)
    reconcile_media_section_bounds(db, media_id=media_id)


def run_job(*, payload: Mapping[str, Any], context: queue.JobExecutionContext) -> queue.JobResult:
    work = _PreparationJob.model_validate(payload)
    id, generation, format = work.media_id, work.expected_source_generation, work.format
    superseded = {"status": "superseded"}
    complete = {"status": "prepared"}
    if work.detector_revision != section_detector_revision(format):
        return superseded

    with get_session_factory()() as db:
        get_repeatable_read_db(db)
        if read_publication_generation(db, media_id=id) != generation:
            return superseded
        proof = read_media_navigation_proof(db, media_id=id, kind=format, generation=generation)
        # An already prepared matching request makes no reads of the original package.
        already_prepared = proof.key == work.expected_navigation_key and _installed_witness(
            db, id
        ) == _witness_key(format, proof)
        package = _capture_package(db, id) if format == "epub" and not already_prepared else None

    plan = None
    if package is not None:
        with parser_attempt_directory(context.job_id) as directory:
            path = _materialize_package(directory, package)
            plan = derive_epub_navigation(
                epub_path=path,
                media_id=id,
                fragments=package.fragments,
                note_regions=package.note_regions,
            )

    def apply(db: Session) -> queue.JobResult:
        from nexus.services.media_parts import require_part_source_creator

        if not lock_media_rows_in_order(db, [id], lock_mode="no_key_update"):
            return superseded
        if queue.lock_running_job_claim(db, context=context) is None:
            return superseded
        try:
            source = require_part_source_creator(
                db, viewer_id=work.requester_user_id, source_media_id=id
            )
        except ApiError:
            return superseded
        if source.kind != format or read_publication_generation(db, media_id=id) != generation:
            return superseded
        current = read_media_navigation_proof(db, media_id=id, kind=format, generation=generation)
        if plan is None:
            if current.key != work.expected_navigation_key:
                return superseded
            witness = _witness_key(format, current)
            if _installed_witness(db, id) == witness:
                return complete
            if format == "epub":
                return superseded
            record_section_witness(db, media_id=id, witness_key=witness)
        else:
            assert package is not None
            installed = _capture_package(db, id)
            if (installed.size_bytes, installed.source_sha256, installed.body_key) != (
                package.size_bytes,
                package.source_sha256,
                package.body_key,
            ):
                return superseded
            witness = _plan_witness(plan, generation)
            if _navigation_output(plan, witness) == _navigation_output(
                _installed_navigation(db, id, generation), _installed_witness(db, id)
            ):
                return complete
            if (
                current.key != work.expected_navigation_key
                or installed.note_key != package.note_key
            ):
                return superseded
            _install_navigation(db, id, generation, plan, witness)
        return complete

    with get_session_factory()() as db:
        return retry_serializable(db, "publish_section_preparation", lambda: apply(db))


@dataclass(frozen=True)
class _RepairBase:
    media_id: UUID
    generation: int
    package: _Package
    navigation_key: str
    navigation: dict[str, object]
    apparatus: ApparatusOutput | None
    apparatus_issues: tuple[TooManyNotes, ...]

    def review(
        self, projection: Literal["navigation", "apparatus"], plan_sha256: str
    ) -> EpubRepairReview:
        return EpubRepairReview(
            projection=projection,
            media_id=self.media_id,
            source_generation=self.generation,
            source_size_bytes=self.package.size_bytes,
            source_sha256=self.package.source_sha256,
            fragments_sha256=self.package.body_key,
            navigation_key=self.navigation_key,
            note_regions_sha256=self.package.note_key,
            apparatus_sha256=None if self.apparatus is None else _digest(self.output["apparatus"]),
            plan_sha256=plan_sha256,
        )

    @property
    def output(self) -> dict[str, object]:
        return {
            "navigation": self.navigation,
            "apparatus": None
            if self.apparatus is None
            else {
                **self.apparatus,
                "issues": [issue.model_dump(mode="json") for issue in self.apparatus_issues],
            },
        }


def _repair_base(
    db: Session, media_id: UUID, projection: Literal["navigation", "apparatus"]
) -> _RepairBase:
    source = db.get(Media, media_id)
    generation = read_publication_generation(db, media_id=media_id)
    if (
        source is None
        or source.kind != "epub"
        or source.processing_status != "ready_for_reading"
        or generation is None
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Published EPUB not found")
    proof = read_media_navigation_proof(db, media_id=media_id, kind="epub", generation=generation)
    apparatus = read_apparatus_output(db, media_id=media_id) if projection == "apparatus" else None
    return _RepairBase(
        media_id,
        generation,
        _capture_package(db, media_id),
        proof.key,
        _navigation_output(
            _installed_navigation(db, media_id, generation), _installed_witness(db, media_id)
        ),
        apparatus,
        tuple(issue for issue in proof.navigation.source_issues if isinstance(issue, TooManyNotes)),
    )


@dataclass(frozen=True)
class _RepairPlan:
    navigation: EpubNavigationPlan
    witness: str
    apparatus: EpubPlan | None
    output: dict[str, object]


def _derive_repair(
    base: _RepairBase, projection: Literal["navigation", "apparatus"]
) -> _RepairPlan:
    package = base.package
    with parser_attempt_directory(uuid4()) as directory:
        path = _materialize_package(directory, package)
        apparatus = None
        apparatus_facts = None
        if projection == "navigation":
            navigation = derive_epub_navigation(
                epub_path=path,
                media_id=base.media_id,
                fragments=package.fragments,
                note_regions=package.note_regions,
            )
        else:
            apparatus = derive_retained_epub_apparatus(
                epub_path=path,
                attempt_directory=directory,
                media_id=base.media_id,
                fragments=package.fragments,
            )
            navigation = EpubNavigationPlan(
                apparatus.sections,
                apparatus.toc_nodes,
                tuple(
                    issue
                    for issue in apparatus.source_issues
                    if isinstance(issue, UnresolvedNavigationTarget)
                ),
            )
            projected = apparatus_output(
                items=apparatus.apparatus_items,
                edges=tuple(
                    edge for fragment in apparatus.fragments for edge in fragment.apparatus_edges
                ),
                note_groups=apparatus.note_groups,
                status="ready" if apparatus.apparatus_items else "empty",
                previous=base.apparatus,
            )
            apparatus_facts = {
                **projected,
                "issues": [
                    issue.model_dump(mode="json")
                    for issue in apparatus.source_issues
                    if isinstance(issue, TooManyNotes)
                ],
            }
    witness = _plan_witness(navigation, base.generation)
    return _RepairPlan(
        navigation,
        witness,
        apparatus,
        {
            "navigation": _navigation_output(navigation, witness),
            "apparatus": apparatus_facts,
        },
    )


def preview_epub_repair(
    media_id: UUID, projection: Literal["navigation", "apparatus"]
) -> dict[str, object]:
    """Return the current and candidate logical projections and their review record."""
    with get_session_factory()() as db:
        base = _repair_base(get_repeatable_read_db(db), media_id, projection)
    plan = _derive_repair(base, projection)
    if plan.apparatus is not None:
        with get_session_factory()() as db:
            validate_preserved_apparatus_replacement(
                get_repeatable_read_db(db),
                media_id=media_id,
                items=plan.apparatus.apparatus_items,
            )
    return {
        "review": base.review(projection, _digest(plan.output)).model_dump(mode="json"),
        "installed": base.output,
        "candidate": plan.output,
    }


def _reviewed_base(db: Session, review: EpubRepairReview) -> _RepairBase | None:
    if not lock_media_rows_in_order(db, [review.media_id], lock_mode="no_key_update"):
        raise _changed()
    current = _repair_base(db, review.media_id, review.projection)
    current_review = current.review(review.projection, review.plan_sha256)
    if (
        current_review.source_generation,
        current_review.source_size_bytes,
        current_review.source_sha256,
        current_review.fragments_sha256,
    ) != (
        review.source_generation,
        review.source_size_bytes,
        review.source_sha256,
        review.fragments_sha256,
    ):
        raise _changed()
    if _digest(current.output) == review.plan_sha256:
        return None
    if current_review != review:
        raise _changed()
    return current


def apply_epub_repair(review: EpubRepairReview) -> Literal["installed", "already_installed"]:
    """Apply exactly the reviewed projection. Replay checks the installed result first."""
    with get_session_factory()() as db:
        base = retry_serializable(db, "capture_epub_repair", lambda: _reviewed_base(db, review))
    if base is None:
        return "already_installed"
    plan = _derive_repair(base, review.projection)
    if _digest(plan.output) != review.plan_sha256:
        raise _changed()

    def apply(db: Session) -> Literal["installed", "already_installed"]:
        id, generation = review.media_id, review.source_generation
        if _reviewed_base(db, review) is None:
            return "already_installed"
        apparatus_issues = None
        if plan.apparatus is not None:
            apparatus = plan.apparatus
            replace_media_apparatus(
                db,
                media_id=id,
                items=[dict(item) for item in apparatus.apparatus_items],
                edges=[
                    dict(edge)
                    for fragment in apparatus.fragments
                    for edge in fragment.apparatus_edges
                ],
                note_groups=list(apparatus.note_groups),
                preserve_fragment_html=True,
            )
            apparatus_issues = tuple(
                issue for issue in apparatus.source_issues if isinstance(issue, TooManyNotes)
            )
        _install_navigation(
            db,
            id,
            generation,
            plan.navigation,
            plan.witness,
            apparatus_issues=apparatus_issues,
        )
        installed = _repair_base(db, id, review.projection)
        if _digest(installed.output) != review.plan_sha256:
            raise _changed()
        return "installed"

    with get_session_factory()() as db:
        return retry_serializable(db, "apply_epub_repair", lambda: apply(db))
