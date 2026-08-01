"""Static negative gate for the web-search persistence owner.

The Browse hard cutover deleted the standalone read-only web-search route
(``api/routes/web_search.py``) but retained the read-only Brave service helper
beneath Browse and chat. Persistence of a web-search run must therefore remain
reachable only from the durable chat tool step: ``persist_web_search_run`` lives
in the chat web_search service and is called only by the chat-run transaction
owner. This is a syntax-aware source-tree check (no DB, no app import), so it
runs in the unit lane.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

# python/tests/ -> python/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_SEARCH_SERVICE = _PY_ROOT / "services" / "agent_tools" / "web_search.py"
_CHAT_RUN_SERVICE = _PY_ROOT / "services" / "chat_runs.py"


def test_web_search_persistence_owner_is_the_chat_tool_path() -> None:
    """The persistence primitive lives in the chat tool service and its sole caller
    is the durable chat-step owner, so no other surface can persist a web-search run.
    """
    definitions: list[tuple[Path, int]] = []
    calls: list[tuple[Path, int]] = []
    for path in _PY_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=path.as_posix())
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
                and node.name == "persist_web_search_run"
            ):
                definitions.append((path, node.lineno))
            if isinstance(node, ast.Call) and (
                (isinstance(node.func, ast.Name) and node.func.id == "persist_web_search_run")
                or (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "persist_web_search_run"
                )
            ):
                calls.append((path, node.lineno))

    assert len(definitions) == 1 and definitions[0][0] == _WEB_SEARCH_SERVICE, (
        "persist_web_search_run must have one canonical definition in the chat tool "
        f"service; found {definitions!r}"
    )
    assert len(calls) == 1 and calls[0][0] == _CHAT_RUN_SERVICE, (
        "persist_web_search_run must have exactly one caller in the durable chat step; "
        f"found {calls!r}"
    )


def test_web_search_persistence_has_one_canonical_identity_path() -> None:
    """Raw provider citations cannot serialize events or commit the caller's step."""
    service_src = _WEB_SEARCH_SERVICE.read_text(encoding="utf-8")
    assert "def retrieval_result_event(" not in service_src
    assert "def to_json(" not in service_src
    assert "source_id or self.result_ref" not in service_src
    assert "db.commit()" not in service_src
    assert "UPDATE message_tool_calls" not in service_src
