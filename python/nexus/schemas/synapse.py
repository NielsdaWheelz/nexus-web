"""Synapse scan wire shapes; the scan state is the job row, projected."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class SynapseScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str


class SynapseScanOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["idle", "pending", "running", "failed"]
