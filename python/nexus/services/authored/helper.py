"""Bounded one-shot semantic kernel. Platform code owns every transaction.

The account head lock serializes calls across API processes. A helper has no
credentials, database or network capability supplied by this owner.
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any
from uuid import UUID

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.authored import Change, Corpus, MergeResult

_package_root = Path(__file__).resolve().parents[3]
# Checkouts keep nexus under python/; immutable images copy it directly to /app.
SCRIPT = (
    _package_root.parent if _package_root.name == "python" else _package_root
) / "node/authored/helper.mjs"


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
        [shutil.which("node") or "node", "--max-old-space-size=128", str(SCRIPT)],
        input=payload,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
        env={"NODE_ENV": "production", "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    if result.returncode != 0:
        if "Semantic input exceeds process budget" in result.stderr:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Authored merge exceeds server capacity")
        if "TypeError:" in result.stderr:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid authored change")
        result.check_returncode()
    return json.loads(result.stdout)
