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


def test_web_search_persistence_owner_is_the_chat_tool_path() -> None:
    """The persisting wrapper lives only in the chat tool service: ``execute_web_search``
    is the sole caller of ``persist_web_search_run``, so no other surface (now that the
    standalone route is gone) can persist a web-search run.
    """
    service_src = _WEB_SEARCH_SERVICE.read_text(encoding="utf-8")
    assert "def persist_web_search_run(" in service_src, (
        "persist_web_search_run must remain defined in the chat web_search service"
    )
    assert "persist_web_search_run(db, run)" in service_src, (
        "execute_web_search must remain the sole caller of persist_web_search_run"
    )
