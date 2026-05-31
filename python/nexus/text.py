"""Text normalization helpers shared across services."""

import re
import unicodedata

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_whitespace(value: str) -> str:
    """NFC-normalize, collapse Unicode whitespace runs to single spaces, and strip.

    `\\s` already matches `\\u00a0` and other Unicode whitespace for `str` patterns.
    """
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFC", value)).strip()
