"""Shared environment path decoding for Codex agent processes."""

from __future__ import annotations

import os
from pathlib import Path


def required_absolute_path(name: str) -> Path:
    """Decode one required environment variable into a normalized absolute path."""

    raw = os.environ.get(name)
    if not raw:
        raise RuntimeError(f"{name} is required")
    path = Path(raw)
    if not path.is_absolute() or os.path.normpath(raw) != raw:
        raise RuntimeError(f"{name} must be a normalized absolute path")
    return path


__all__ = ["required_absolute_path"]
