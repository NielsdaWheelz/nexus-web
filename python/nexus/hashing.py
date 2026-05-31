"""Stable hashing helpers for persisted request identities."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping


def stable_json_hash(value: Mapping[str, object]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
