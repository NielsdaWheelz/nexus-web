"""Dependency-light durable value algebra for frozen model-tool plans."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class _FrozenSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class FrozenToolLimitsSnapshot(_FrozenSnapshot):
    deadline_seconds: float
    max_attempts: int
    max_input_bytes: int
    max_output_bytes: int


class FrozenRunLimitsSnapshot(_FrozenSnapshot):
    max_calls: int
    max_elapsed_seconds: float
    max_external_attempts: int
    max_in_flight: int
    max_input_bytes: int
    max_output_bytes: int


class FrozenToolGrantSnapshot(_FrozenSnapshot):
    binding_policy_revision: str
    id: str
    implementation_revision: str
    limits: FrozenToolLimitsSnapshot
    replay_policy: Literal["BilledOnce", "ReDispatchable"]
    tool_contract_revision: str


class FrozenToolExposureSnapshot(_FrozenSnapshot):
    type: Literal["HostTable", "Native"]


class FrozenToolPlanSnapshot(_FrozenSnapshot):
    exposure: FrozenToolExposureSnapshot
    grants: tuple[FrozenToolGrantSnapshot, ...]
    max_live_writes: int | None
    plan_id: str
    plan_revision: str
    profile_id: str
    profile_revision: str
    run_limits: FrozenRunLimitsSnapshot


__all__ = [
    "FrozenRunLimitsSnapshot",
    "FrozenToolExposureSnapshot",
    "FrozenToolGrantSnapshot",
    "FrozenToolLimitsSnapshot",
    "FrozenToolPlanSnapshot",
]
