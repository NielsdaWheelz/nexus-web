"""Decoding of a subscription's stored playback settings."""

from __future__ import annotations

from typing import cast

from nexus.schemas.consumption import PauseShorteningMode
from nexus.schemas.presence import Absent, Present, absent, present


def pause_shortening_mode_from_nullable(value: object) -> Absent | Present[PauseShorteningMode]:
    """Decode the nullable subscription override; NULL means the device default."""
    if value is None:
        return absent()
    return present(cast(PauseShorteningMode, str(value)))
