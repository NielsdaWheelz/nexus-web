"""Wire schemas for the synapse scan API.

Scan state is a projection of the background-job row: there is no scan
resource to hydrate, so ``status`` is the whole read surface.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

SynapseScanStatus = Literal["idle", "pending", "running"]


class SynapseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SynapseScanRequest(SynapseModel):
    ref: str


class SynapseScanOut(SynapseModel):
    """``queued`` is False when the engine is disabled or a scan is in flight."""

    queued: bool
    status: SynapseScanStatus


class SynapseScanStatusOut(SynapseModel):
    status: SynapseScanStatus
