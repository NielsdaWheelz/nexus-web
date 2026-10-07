"""Wire schemas for the connection discovery scan API.

Scan state is a projection of the background-job row: there is no scan
resource to hydrate, so ``status`` is the whole read surface.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

DiscoveryScanStatus = Literal["idle", "pending", "running"]


class DiscoveryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DiscoveryScanRequest(DiscoveryModel):
    ref: str


class DiscoveryScanOut(DiscoveryModel):
    """``queued`` is False when the engine is disabled or a scan is in flight."""

    queued: bool
    status: DiscoveryScanStatus


class DiscoveryScanStatusOut(DiscoveryModel):
    status: DiscoveryScanStatus
