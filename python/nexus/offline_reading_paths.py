"""Dependency-free direct offline-reading route predicates."""

from uuid import UUID

_PACKAGE_PREFIX = "/offline-reading/packages/"


def is_offline_reading_package_path(path: str) -> bool:
    if not path.startswith(_PACKAGE_PREFIX):
        return False
    media_text = path.removeprefix(_PACKAGE_PREFIX)
    try:
        media_id = UUID(media_text)
    except ValueError:
        return False
    return str(media_id) == media_text
