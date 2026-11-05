"""Storage's declared failures, independent of its SDK and transport imports."""

from typing import Literal

type StorageErrorCode = Literal["E_STORAGE_ERROR", "E_STORAGE_MISSING"]
type StorageFailureReason = Literal["transient", "configuration", "missing", "integrity", "defect"]


class StorageError(Exception):
    """An API caller maps the code; durable work uses the already classified reason."""

    def __init__(
        self,
        message: str,
        code: StorageErrorCode = "E_STORAGE_ERROR",
        *,
        reason: StorageFailureReason = "defect",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code: StorageErrorCode = code
        self.reason: StorageFailureReason = reason
