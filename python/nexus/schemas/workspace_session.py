"""Workspace session schemas."""

import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_WORKSPACE_STATE_BYTES = 65_536


class WorkspaceSessionPutRequest(BaseModel):
    """PUT body for a per-device workspace session."""

    device_id: str = Field(min_length=1, max_length=200)
    state: dict[str, object]

    model_config = ConfigDict(extra="forbid")

    @field_validator("state")
    @classmethod
    def reject_oversized_state(cls, value: dict[str, object]) -> dict[str, object]:
        """Reject a serialized state blob over the size cap."""

        if len(json.dumps(value)) > MAX_WORKSPACE_STATE_BYTES:
            raise ValueError("workspace state exceeds maximum size")
        return value
