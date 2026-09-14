"""Telemetry ingest schemas.

Request bodies for browser-emitted observability samples (Real User Monitoring).
These are pure telemetry payloads: validated at the route edge and logged, never
persisted. Keys are snake_case so the BFF can forward them without aliases.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence


class WebVitalRequest(BaseModel):
    """One Core Web Vital sample reported by the browser."""

    name: Literal["LCP", "INP", "CLS", "TTFB"]
    value: float
    rating: Literal["good", "needs-improvement", "poor"]
    id: str = Field(min_length=1, max_length=200)
    href: str = Field(max_length=2048)
    nav_id: str = Field(max_length=200)

    model_config = ConfigDict(extra="forbid")


class _ClientDefectFields(BaseModel):
    """One bounded structural failure report; no exception or request payload."""

    release: str = Field(min_length=1, max_length=128)
    phase: Literal["Admission", "Read", "Render"]
    command_id: Presence[Annotated[str, Field(min_length=1, max_length=128)]]
    run_id: Presence[UUID]
    error_code: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
    request_id: Presence[Annotated[str, Field(min_length=1, max_length=200)]]
    component_stack: str = Field(max_length=8000)

    model_config = ConfigDict(extra="forbid")


class PaneClientDefectRequest(_ClientDefectFields):
    scope: Literal["Pane"]
    pane_id: str = Field(min_length=1, max_length=128)
    visit_id: str = Field(min_length=1, max_length=128)


class FeatureClientDefectRequest(_ClientDefectFields):
    scope: Literal["Nexus", "Workspace", "ReaderProgress", "ReaderContent", "Imports", "Artwork"]


ClientDefectRequest = Annotated[
    PaneClientDefectRequest | FeatureClientDefectRequest, Field(discriminator="scope")
]
