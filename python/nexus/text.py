"""Text normalization helpers shared across services."""

import re
import unicodedata

_WHITESPACE_RE = re.compile(r"\s+")
# The web's collapseWhitespace uses ECMAScript \s, which differs from Python's.
# Keep this explicit so persisted visit hints and note excerpts agree across clients.
ECMASCRIPT_WHITESPACE = (
    "[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def collapse_whitespace(value: str) -> str:
    """Collapse the web's whitespace set without changing the text's Unicode form."""
    return re.sub(ECMASCRIPT_WHITESPACE, " ", value).strip(" ")


def normalize_whitespace(value: str) -> str:
    """NFC-normalize, collapse Unicode whitespace runs to single spaces, and strip.

    `\\s` already matches `\\u00a0` and other Unicode whitespace for `str` patterns.
    """
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFC", value)).strip()


def escape_like(value: str) -> str:
    """Escape a literal for a LIKE pattern using the backslash ESCAPE character."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
