"""ConnectionDiscovery scan wire shapes; the scan state is the job row, projected."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class ConnectionDiscoveryScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str


class ConnectionDiscoveryScanOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["idle", "pending", "running", "failed"]
    outcome: Literal["ok", "skipped", "terminal_failed"] | None
