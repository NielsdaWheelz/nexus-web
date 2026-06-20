"""Schemas for local Markdown vault sync."""

from pydantic import BaseModel, ConfigDict, Field
from pydantic.functional_validators import field_validator

from nexus.services.vault_contracts import (
    VAULT_FILE_CONTENT_BYTE_LIMIT,
    parse_editable_vault_path,
)


def _validate_content_utf8_byte_size(content: str) -> str:
    if len(content.encode("utf-8")) > VAULT_FILE_CONTENT_BYTE_LIMIT:
        raise ValueError("content must be at most 1,000,000 UTF-8 bytes")
    return content


class VaultEditableFileIn(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    content: str

    model_config = ConfigDict(extra="forbid")

    @field_validator("path")
    @classmethod
    def validate_path(cls, path: str) -> str:
        return parse_editable_vault_path(path)

    @field_validator("content")
    @classmethod
    def validate_content(cls, content: str) -> str:
        return _validate_content_utf8_byte_size(content)


class VaultProjectedFileOut(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    content: str

    model_config = ConfigDict(extra="forbid")

    @field_validator("content")
    @classmethod
    def validate_content(cls, content: str) -> str:
        return _validate_content_utf8_byte_size(content)


class VaultConflictOut(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    message: str = Field(..., min_length=1, max_length=500)
    content: str

    model_config = ConfigDict(extra="forbid")


class VaultSyncRequest(BaseModel):
    files: list[VaultEditableFileIn] = Field(..., max_length=5000)

    model_config = ConfigDict(extra="forbid")


class VaultSnapshotOut(BaseModel):
    files: list[VaultProjectedFileOut]
    delete_paths: list[str] = Field(default_factory=list)
    conflicts: list[VaultConflictOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")
