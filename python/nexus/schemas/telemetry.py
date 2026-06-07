"""Telemetry ingest schemas.

Request bodies for browser-emitted observability samples (Real User Monitoring).
These are pure telemetry payloads: validated at the route edge and logged, never
persisted. Keys are snake_case so the BFF can forward them without aliases.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class WebVitalRequest(BaseModel):
    """One Core Web Vital sample reported by the browser."""

    name: Literal["LCP", "INP", "CLS", "TTFB"]
    value: float
    rating: Literal["good", "needs-improvement", "poor"]
    id: str = Field(min_length=1, max_length=200)
    href: str = Field(max_length=2048)
    nav_id: str = Field(max_length=200)

    model_config = ConfigDict(extra="forbid")
