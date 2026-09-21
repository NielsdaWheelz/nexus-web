"""Terminal upload-failure value types.

A leaf: the upload-session response and the import-history vocabulary both name
these facts, and history is read by the background supervisor, which must never
load the ORM. Nothing here imports another Nexus module.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

UploadVerificationFailureCode = Literal[
    "E_SOURCE_INTEGRITY",
    "E_INVALID_FILE_TYPE",
    "E_FILE_TOO_LARGE",
]
"""The closed set of deterministic upload rejections recorded on a session.

A plain alias rather than a ``type`` statement, so the same declaration is also
the runtime source of the codes (``typing.get_args``).
"""


class UploadTransportNetworkFailure(BaseModel):
    kind: Literal["Network"] = "Network"

    model_config = ConfigDict(extra="forbid")


class UploadTransportTimeoutFailure(BaseModel):
    kind: Literal["Timeout"] = "Timeout"

    model_config = ConfigDict(extra="forbid")


class UploadTransportHttpRejectedFailure(BaseModel):
    kind: Literal["HttpRejected"] = "HttpRejected"
    status: int = Field(ge=100, le=599)

    model_config = ConfigDict(extra="forbid")


class UploadTransportAbortedFailure(BaseModel):
    kind: Literal["Aborted"] = "Aborted"

    model_config = ConfigDict(extra="forbid")


UploadTransportFailure = Annotated[
    UploadTransportNetworkFailure
    | UploadTransportTimeoutFailure
    | UploadTransportHttpRejectedFailure
    | UploadTransportAbortedFailure,
    Field(discriminator="kind"),
]
