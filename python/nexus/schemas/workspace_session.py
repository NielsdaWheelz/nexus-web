"""Workspace session schemas."""

import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_WORKSPACE_STATE_BYTES = 65_536
WORKSPACE_SESSION_DEVICE_ID_MIN_LENGTH = 1
WORKSPACE_SESSION_DEVICE_ID_MAX_LENGTH = 200


class WorkspaceSessionOut(BaseModel):
    """API projection of a stored workspace session row."""

    state: dict[str, object]
    updated_at: str


class WorkspaceSessionPutRequest(BaseModel):
    """PUT body for a per-device workspace session."""

    device_id: str = Field(
        min_length=WORKSPACE_SESSION_DEVICE_ID_MIN_LENGTH,
        max_length=WORKSPACE_SESSION_DEVICE_ID_MAX_LENGTH,
    )
    state: dict[str, object]

    model_config = ConfigDict(extra="forbid")

    @field_validator("state")
    @classmethod
    def reject_oversized_state(cls, value: dict[str, object]) -> dict[str, object]:
        """Reject a serialized state blob over the size cap."""

        if len(json.dumps(value)) > MAX_WORKSPACE_STATE_BYTES:
            raise ValueError("workspace state exceeds maximum size")
        return value
