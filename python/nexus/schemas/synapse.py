"""Wire schemas for the synapse resonance scan API (synapse spec §8).

Refs travel as ``<scheme>:<uuid>`` URI strings on the wire; routes parse them
into typed ``ResourceRef`` values at the boundary. Scan state is a projection
of the background-job row (spec D5) — there is no scan resource to hydrate,
so ``status`` is the whole read surface.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

SynapseScanStatus = Literal["idle", "pending", "running"]


class SynapseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SynapseScanRequest(SynapseModel):
    """Body for POST /synapse/scans (manual scan)."""

    ref: str


class SynapseScanOut(SynapseModel):
    """Enqueue receipt: ``queued`` is False when deduped against an in-flight
    scan or the engine is disabled; ``status`` reflects the job row either way.
    """

    queued: bool
    status: SynapseScanStatus


class SynapseScanStatusOut(SynapseModel):
    """Scan state for GET /synapse/scans."""

    status: SynapseScanStatus
