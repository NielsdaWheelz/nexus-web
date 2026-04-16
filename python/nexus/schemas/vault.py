"""Schemas for local Markdown vault sync."""

from pydantic import BaseModel, Field


class VaultFile(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., max_length=1_000_000)


class VaultConflict(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    message: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., max_length=1_000_000)


class VaultSyncRequest(BaseModel):
    files: list[VaultFile] = Field(default_factory=list, max_length=5000)


class VaultSnapshotOut(BaseModel):
    files: list[VaultFile]
    delete_paths: list[str] = Field(default_factory=list)
    conflicts: list[VaultConflict] = Field(default_factory=list)
