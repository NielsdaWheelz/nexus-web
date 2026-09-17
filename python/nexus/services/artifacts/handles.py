"""The outward identity of one artifact build (CP2-TYPES, CONTRACTS.md A9/A19/B0).

Every route that names a build (cancel, event stream) speaks the build's
``artifact_builds.id`` as an opaque string. The handle *identifies but never
authorizes* — authorization is always a separate check on the resolved
build/head. There is deliberately no ``build`` ResourceScheme.
"""

from __future__ import annotations

from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError


class InvalidArtifactBuildHandle(InvalidRequestError):
    """The outward handle is not a build identity."""

    def __init__(self, message: str = "Invalid artifact build handle") -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, message)


def seal_artifact_build(build_id: UUID) -> str:
    """Mint the outward handle for an internal build id."""
    return str(build_id)


def unseal_artifact_build(raw: str) -> UUID:
    """Recover the internal build id from an outward handle, or raise
    :class:`InvalidArtifactBuildHandle` on malformed input."""
    try:
        return UUID(raw)
    except ValueError as exc:
        raise InvalidArtifactBuildHandle from exc
