"""Small authenticated preparation/status boundary; no reader parser imports."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

OFFLINE_ARCHIVE_SCHEMA_VERSION = 2
OFFLINE_ARCHIVE_MEMBER_KEY = f"offline/schema-{OFFLINE_ARCHIVE_SCHEMA_VERSION}.zip"

# Existing native ReadingFailureReason values relevant to server preparation.
OfflinePackageFailureReason = Literal["Server", "SourceUnavailable", "TooLarge", "Integrity"]

# The preparation job records one of these codes when it rejects a publication
# for a named, permanent condition; every other failure stays `Server`.
OFFLINE_PACKAGE_FAILURE_CODES: dict[OfflinePackageFailureReason, str] = {
    "SourceUnavailable": "E_OFFLINE_PACKAGE_SOURCE_UNAVAILABLE",
    "TooLarge": "E_OFFLINE_PACKAGE_TOO_LARGE",
    "Integrity": "E_OFFLINE_PACKAGE_INTEGRITY",
}
OFFLINE_PACKAGE_FAILURE_REASONS: dict[str, OfflinePackageFailureReason] = {
    code: reason for reason, code in OFFLINE_PACKAGE_FAILURE_CODES.items()
}


class _PreparationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class OfflineReadingTokenRequest(_PreparationModel):
    expected_reader_generation: int = Field(ge=1)


class OfflinePackagePreparing(_PreparationModel):
    kind: Literal["Preparing"] = "Preparing"


class OfflinePackageReady(_PreparationModel):
    kind: Literal["Ready"] = "Ready"


class OfflinePackageFailed(_PreparationModel):
    kind: Literal["Failed"] = "Failed"
    reason: OfflinePackageFailureReason


class OfflinePackageStatus(_PreparationModel):
    reader_generation: int = Field(ge=1)
    state: Annotated[
        OfflinePackagePreparing | OfflinePackageReady | OfflinePackageFailed,
        Field(discriminator="kind"),
    ]
