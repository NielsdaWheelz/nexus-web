"""Oracle wire models (one reading shape for detail and the status stream) and the two
jsonb shapes the reading row stores: its passages and a captured plate."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

import regex
from pydantic import AfterValidator, BaseModel, StringConstraints

from nexus.schemas.citation import (
    CitationOut,
    CitationRole,
    CitationSnapshotOut,
    CitationTargetRef,
)

# The browser's rule (lib/oracle/oracle.ts): Unicode White_Space at either end, so
# U+0085 goes and U+FEFF stays; str.strip and pydantic's trim also take U+001C–U+001F.
_EDGE_SPACE = regex.compile(r"\A\p{White_Space}+|\p{White_Space}+\Z")

# `streaming` is history only: a stored streaming row, or a pending one whose retired
# log had started (`started_at`); either is unfinished, like `pending`.
type OracleReadingStatus = Literal["pending", "streaming", "complete", "failed"]
type OraclePhase = Literal["descent", "ordeal", "ascent"]
type OracleSourceKind = Literal["public_domain", "user_media"]
type OracleFailureCode = Literal[
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
    "cancelled",
    "E_ORACLE_CORPUS_NOT_READY",
    "E_APP_SEARCH_FAILED",
    "E_GENERATION_SOURCE_CHANGED",
]


class OracleReadingCreateRequest(BaseModel):
    question: Annotated[
        str,
        AfterValidator(lambda question: _EDGE_SPACE.sub("", question)),
        StringConstraints(min_length=1, max_length=280),
    ]


class OracleReadingCreatedOut(BaseModel):
    reading_id: UUID


class OraclePlateOut(BaseModel):
    """A plate; its image is the static asset ``/oracle-plates/{key}.jpg``. Also the
    shape of ``oracle_readings.plate``, the display publication (or history) captured."""

    key: str
    artist: str
    work_title: str
    year: str | None
    attribution: str
    width: int
    height: int


class OraclePassageText(BaseModel):
    """What a passage says; publication or history wrote it once."""

    phase: OraclePhase
    source_kind: OracleSourceKind
    quote: str
    attribution: str
    locator_label: str | None
    marginalia: str


class OracleCitationFacts(BaseModel):
    """A historical passage's captured citation: its saved target and hover facts."""

    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    deep_link: str | None
    snapshot: CitationSnapshotOut | None


class OracleStoredPassage(OraclePassageText):
    """One element of ``oracle_readings.passages``. ``ordinal`` names the reading's own
    citation edge (null when history saved only a target); ``citation`` holds captured
    facts (null when the edge carries them, as for every published reading)."""

    ordinal: int | None
    citation: OracleCitationFacts | None


class OraclePassageOut(OraclePassageText):
    """One phase's passage; ``citation`` is its current navigation, null when the
    target is unavailable (typography)."""

    citation: CitationOut | None


class OracleReadingOut(BaseModel):
    """The reading: every fact it has; a pending one has none, history may be partial."""

    id: UUID
    folio_number: int
    question_text: str
    status: OracleReadingStatus
    created_at: datetime
    folio_motto: str | None
    folio_motto_gloss: str | None
    folio_theme: str | None
    argument_text: str | None
    interpretation_text: str | None
    omens: list[str]
    plate: OraclePlateOut | None
    passages: list[OraclePassageOut]  # descent, ordeal, ascent
    error_code: OracleFailureCode | None


class OracleReadingSummaryOut(BaseModel):
    id: UUID
    folio_number: int
    status: OracleReadingStatus
    folio_motto: str | None
    folio_theme: str | None
    plate: OraclePlateOut | None


class OracleConcordanceOut(BaseModel):
    id: UUID
    folio_number: int
    folio_motto: str
    folio_theme: str | None
    shared_plate: bool
    shared_theme: bool
    shared_passage_count: int
