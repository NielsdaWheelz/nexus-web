"""Bind durable browser/native operations to their originally authenticated account."""

from uuid import UUID

from nexus.errors import ApiErrorCode, ForbiddenError


def require_expected_account(viewer_id: UUID, expected_account_id: UUID) -> None:
    if expected_account_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Account binding does not match authenticated viewer"
        )
