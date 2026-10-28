"""Bounded one-shot semantic kernel. Platform code owns every transaction.

The account head lock serializes calls across API processes. A helper has no
credentials, database or network capability supplied by this owner.
The process exits with 2 for invalid input and 3 for input capacity; stderr is
diagnostic text, never a failure discriminator. Other exits remain defects.
"""

import json
import subprocess
from functools import cache
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.authored import Change, Corpus, MergeResult

_package_root = Path(__file__).resolve().parents[3]
# Checkouts keep nexus under python/; immutable images copy it directly to /app.
SCRIPT = (
    _package_root.parent if _package_root.name == "python" else _package_root
) / "node/authored/helper.mjs"


@cache
def node_binary() -> str:
    """Resolve the installed runtime behind a trusted toolchain shim, once."""
    return subprocess.run(
        ["node", "-p", "process.execPath"], text=True, capture_output=True, timeout=30, check=True
    ).stdout.strip()


def merge(account_id: UUID, states: Corpus, changes: list[Change]) -> MergeResult:
    return MergeResult.model_validate(
        call(
            {
                "op": "merge",
                "account_id": str(account_id),
                "states": states.model_dump(mode="json"),
                "changes": [change.model_dump(mode="json") for change in changes],
            }
        )
    )


def call(value: dict[str, Any]) -> Any:
    payload = json.dumps(
        value,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    result = subprocess.run(
        [node_binary(), "--max-old-space-size=128", str(SCRIPT)],
        input=payload,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
        env={"NODE_ENV": "production", "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    if result.returncode == 3:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Authored merge exceeds server capacity")
    if result.returncode == 2:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid authored change")
    result.check_returncode()
    return json.loads(result.stdout)


def call_items(
    op: Literal[
        "project_excerpts",
        "scope_excerpts",
        "excerpt_source_selections",
        "capture_excerpts",
        "excerpt_text_parts",
    ],
    items: list[dict[str, Any]],
) -> list[Any]:
    """One closed batch protocol, bounded below the helper's complete stdin budget."""
    out = []
    batch = []
    size = 64
    for item in items:
        item_size = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode())
        if item_size > 10 * 1024 * 1024:
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Source capture exceeds helper capacity"
            )
        if batch and size + item_size > 10 * 1024 * 1024:
            out.extend(call({"op": op, "items": batch})["items"])
            batch, size = [], 64
        batch.append(item)
        size += item_size + 1
    if batch:
        out.extend(call({"op": op, "items": batch})["items"])
    return out
