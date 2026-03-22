"""Principal-level authorization helpers.

These checks operate on authenticated viewer identity claims and explicit
configuration allowlists, rather than transport-layer controls.
"""

from nexus.auth.middleware import Viewer
from nexus.config import Settings, get_settings


def can_manage_podcast_plan_entitlements(
    viewer: Viewer,
    *,
    settings: Settings | None = None,
) -> bool:
    """Return True if viewer is an authorized billing/admin principal."""
    effective_settings = settings or get_settings()

    if viewer.user_id in effective_settings.podcast_plan_admin_user_id_set:
        return True

    viewer_email = (viewer.email or "").strip().lower()
    if viewer_email and viewer_email in effective_settings.podcast_plan_admin_email_set:
        return True

    if viewer.roles & effective_settings.podcast_plan_admin_role_set:
        return True

    return False
