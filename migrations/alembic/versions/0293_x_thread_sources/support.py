"""The small application definitions 0293's frozen modules name, from d6f04890c.

Each is copied from the d6f04890c source named above it, narrowed to what 0293 reaches.
"""

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from . import text_quote


# python/nexus/errors.py: the codes the frozen modules raise, and their error types. A
# raise aborts 0293's transaction, as it aborted d6f04890c's.
class ApiErrorCode:
    E_INTERNAL = "E_INTERNAL"
    E_INVALID_REQUEST = "E_INVALID_REQUEST"
    E_NOT_FOUND = "E_NOT_FOUND"
    E_RESOURCE_CONFLICT = "E_RESOURCE_CONFLICT"


class ApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class NotFoundError(ApiError):
    pass


class InvalidRequestError(ApiError):
    pass


type ResourceFailureDimension = Literal["Memory", "Time", "Structure", "Output"]


# python/nexus/text.py
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_whitespace(value: str) -> str:
    """NFC-normalize, collapse Unicode whitespace runs to single spaces, and strip.

    `\\s` already matches `\\u00a0` and other Unicode whitespace for `str` patterns.
    """
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFC", value)).strip()


# python/nexus/web_paths.py
API_PREFIX = "/api"


def media_image_url(encoded_url: str) -> str:
    return f"{API_PREFIX}/media/image?url={encoded_url}"


# python/nexus/services/parser_temp.py
def utf8_byte_length(value: str) -> int:
    return len(value.encode())


def nested_utf8_byte_length(value: object) -> int:
    """Count the UTF-8 bytes of every string reachable inside one parser output."""
    if isinstance(value, str):
        return utf8_byte_length(value)
    if isinstance(value, Mapping):
        return sum(
            nested_utf8_byte_length(key) + nested_utf8_byte_length(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence):
        return sum(nested_utf8_byte_length(item) for item in value)
    return 0


# python/nexus/services/fragment_blocks.py
@dataclass
class FragmentBlockSpec:
    block_idx: int
    start_offset: int
    end_offset: int


# python/nexus/services/reader_apparatus.py
def stable_token(value: str) -> str:
    """An opaque key segment derived from the entire source identity."""
    return hashlib.sha256(value.encode()).hexdigest()


# python/nexus/services/passage_anchors.py
def normalize_quote_text(text: str) -> str:
    """Canonical quote normalization: NFC, whitespace runs -> U+0020, trimmed."""
    return text_quote.normalize_for_match(text).text.strip()


def compute_anchor_key(*, exact: str, prefix: str, suffix: str) -> str:
    """sha256 hex over canonical JSON of the already-normalized quote identity."""
    canonical = json.dumps(
        {"exact": exact, "prefix": prefix, "suffix": suffix},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
