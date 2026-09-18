"""Current passage navigation targets; PDF position is known only to a page."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from nexus.schemas.reader import ReaderTargetModel, ReaderTextOffsets, ReaderTimeRange


class NotePassageTarget(ReaderTextOffsets):
    kind: Literal["NoteTextOffsets"] = "NoteTextOffsets"


class FragmentPassageTarget(ReaderTextOffsets):
    kind: Literal["FragmentTextOffsets"] = "FragmentTextOffsets"
    fragment_id: UUID


class TimePassageTarget(ReaderTimeRange):
    kind: Literal["TimeRange"] = "TimeRange"


class PdfPassageTarget(ReaderTargetModel):
    kind: Literal["PdfPage"] = "PdfPage"
    page_number: int = Field(ge=1, le=2**31 - 1)


PassageTarget = Annotated[
    NotePassageTarget | FragmentPassageTarget | TimePassageTarget | PdfPassageTarget,
    Field(discriminator="kind"),
]
