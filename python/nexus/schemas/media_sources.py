"""Source wire models: url and file imports, their progress, retry and repair."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import UUID4, BaseModel, ConfigDict, Field

from nexus.db.models import ProcessingStatus
from nexus.schemas.acquisition import AcquisitionGuard
from nexus.schemas.import_history import UploadVerificationFailureCode
from nexus.schemas.import_refs import ImportRef
from nexus.schemas.library import LibraryPlacementsOut


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


class SourceStageProgress(_Strict):
    kind: Literal["Stage"] = "Stage"
    stage: Literal["Validate", "Extract", "Finalize"]
    updated_at: datetime


class SourceCountedProgress(_Strict):
    kind: Literal["Counted"] = "Counted"
    stage: Literal["Extract"] = "Extract"
    completed: int = Field(ge=0)
    total: int = Field(gt=0)
    unit: Literal["Page", "Chapter"]
    updated_at: datetime


SourceProgress = Annotated[SourceStageProgress | SourceCountedProgress, Field(discriminator="kind")]


class CreateUploadRequest(_Strict):
    """``id`` is the client's session id; a resend advances an unpublished session."""

    id: UUID
    kind: Literal["pdf", "epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    library_ids: list[UUID] = Field(default_factory=list)


class ConfirmUploadRequest(AcquisitionGuard):
    generation: int = Field(ge=1)


class UploadRequired(_Strict):
    """PUT the exact bytes to ``upload_url`` with ``Content-Type: content_type`` before
    ``expires_at``, then confirm ``generation``."""

    kind: Literal["UploadRequired"] = "UploadRequired"
    import_ref: ImportRef
    session_id: UUID
    generation: int = Field(ge=1)
    upload_url: str
    content_type: str
    expires_at: datetime


class Published(_Strict):
    kind: Literal["Published"] = "Published"
    import_ref: ImportRef
    session_id: UUID
    media_id: UUID
    current_placements: LibraryPlacementsOut | None
    created: bool
    """The session's own media (false: a capture reused identical bytes, I8)."""


class Rejected(_Strict):
    """Verification refused the bytes; only removal remains."""

    kind: Literal["Rejected"] = "Rejected"
    import_ref: ImportRef
    session_id: UUID
    code: UploadVerificationFailureCode


UploadSessionOut = Annotated[UploadRequired | Published | Rejected, Field(discriminator="kind")]


class RetrySourceRequest(_Strict):
    expected_attempt_id: UUID


class SourceRepairRequest(_Strict):
    """Requeue the exact dead job of one nonterminal source attempt."""

    kind: Literal["Source"]
    expected_attempt_id: UUID
    expected_job_id: UUID


class SearchRepairRequest(_Strict):
    """Requeue the exact dead reindex job of one content-index revision."""

    kind: Literal["Search"]
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID


MediaRepairRequest = Annotated[
    SourceRepairRequest | SearchRepairRequest, Field(discriminator="kind")
]


class RefreshSourceRequest(_Strict):
    expected_attempt_id: UUID


class SourceAdmission(_Strict):
    """A retry's or refresh's attempt and its job (none for a successor born settled)."""

    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID | None


class SourceRepairAdmission(_Strict):
    kind: Literal["SourceRepair"] = "SourceRepair"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID


class SearchRepairAdmission(_Strict):
    kind: Literal["SearchRepair"] = "SearchRepair"
    media_id: UUID
    revision: int = Field(ge=0)
    job_id: UUID


MediaRepairAdmission = Annotated[
    SourceRepairAdmission | SearchRepairAdmission, Field(discriminator="kind")
]


class FromUrlRequest(AcquisitionGuard):
    """``id`` is the client-minted attempt id: resending it answers the same acceptance.

    Version 4 only: successor and system ids are version 5 (``uuid5``), so a client id
    can never name an attempt the server derives (I10)."""

    id: UUID4
    url: str = Field(
        min_length=1,
        description="The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.",
    )


class FromUrlOut(_Strict):
    import_ref: ImportRef
    media_id: UUID
    source_attempt_id: UUID
    created: bool
    """The answered attempt is this request's own and its media's first."""
    processing_status: ProcessingStatus


class SourceAttemptOut(_Strict):
    """The current destination of an acceptance and whether that identity is settled.

    Processing outcomes belong to Imports. Settlement follows the current
    destination's latest source attempt, including after supersession.
    """

    source_attempt_id: UUID
    media_id: UUID
    import_ref: ImportRef
    settled: bool
