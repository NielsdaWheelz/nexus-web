"""Client-defect report schema.

Validated at the route edge and logged, never persisted. Keys are snake_case so
the BFF can forward them without aliases.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence


class ClientDefectRequest(BaseModel):
    """One bounded structural failure report; no exception or request payload."""

    release: str = Field(min_length=1, max_length=128)
    pane_id: str = Field(min_length=1, max_length=128)
    visit_id: str = Field(min_length=1, max_length=128)
    phase: Literal["Admission", "Read", "Render"]
    command_id: Presence[Annotated[str, Field(min_length=1, max_length=128)]]
    run_id: Presence[UUID]
    error_code: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
    request_id: Presence[Annotated[str, Field(min_length=1, max_length=200)]]
    component_stack: str = Field(max_length=8000)

    model_config = ConfigDict(extra="forbid")
