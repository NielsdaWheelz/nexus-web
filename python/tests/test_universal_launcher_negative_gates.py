"""Static negative gate for the web-search persistence owner.

The Browse hard cutover deleted the standalone read-only web-search route
(``api/routes/web_search.py``) but retained the read-only Brave service helper
beneath Browse and chat. Persistence of a web-search run must therefore remain
reachable only from the chat tool path: ``persist_web_search_run`` lives in the
chat web_search service and is called nowhere else. This is a pure repo-text grep
(no DB, no app import), so it runs in the unit lane.
"""

from __future__ import annotations

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
    service_src = _WEB_SEARCH_SERVICE.read_text(encoding="utf-8")
    chat_run_src = _CHAT_RUN_SERVICE.read_text(encoding="utf-8")
    assert "def persist_web_search_run(" in service_src, (
        "persist_web_search_run must remain defined in the chat web_search service"
    )
    assert chat_run_src.count("persist_web_search_run(") == 1, (
        "the durable chat-step owner must call persist_web_search_run exactly once"
    )
    for path in _PY_ROOT.rglob("*.py"):
        if path in {_WEB_SEARCH_SERVICE, _CHAT_RUN_SERVICE}:
            continue
        assert "persist_web_search_run(" not in path.read_text(encoding="utf-8"), (
            f"web-search persistence escaped the durable chat-step owner: {path}"
        )


def test_web_search_persistence_has_one_canonical_identity_path() -> None:
    """Raw provider citations cannot serialize events or commit the caller's step."""
    service_src = _WEB_SEARCH_SERVICE.read_text(encoding="utf-8")
    assert "def retrieval_result_event(" not in service_src
    assert "def to_json(" not in service_src
    assert "source_id or self.result_ref" not in service_src
    assert "db.commit()" not in service_src
    assert "UPDATE message_tool_calls" not in service_src
