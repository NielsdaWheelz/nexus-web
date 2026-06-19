"""Static negative gates for the universal launcher hard cutover (§14).

The standalone read-only web-search route reuses the chat tool's provider and
projection (``search_web_readonly``) but must NEVER persist: per §14 + N6/D-8,
``persist_web_search_run`` is reachable only from the chat tool path, and the route
writes zero ``resource_external_snapshots`` rows. These are pure repo-text greps
(no DB, no app import), so they run in the unit lane and fail with a file pointer if
the route ever regains a persistence call.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

# python/tests/ -> python/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_SEARCH_ROUTE = _PY_ROOT / "api" / "routes" / "web_search.py"
_WEB_SEARCH_SERVICE = _PY_ROOT / "services" / "agent_tools" / "web_search.py"


def test_web_search_route_does_not_persist() -> None:
    """The read-only route source contains no persistence call or snapshot write.

    Bans the persisting wrapper (``persist_web_search_run``) and any
    ``resource_external_snapshots`` / ``ResourceExternalSnapshot`` write so the route
    stays read-only (§14, N6, D-8). The chat wrapper ``execute_web_search`` may be
    named in the docstring (to describe the contract) but must not be persisted-to
    here — its own symbol is the persist owner asserted by the next gate.
    """
    route_src = _WEB_SEARCH_ROUTE.read_text(encoding="utf-8")
    forbidden = (
        "persist_web_search_run",
        "ResourceExternalSnapshot",
        "resource_external_snapshots",
    )
    present = [token for token in forbidden if token in route_src]
    assert not present, (
        f"{_WEB_SEARCH_ROUTE.as_posix()} must stay read-only but references "
        f"persistence symbols: {present}"
    )


def test_web_search_persistence_owner_is_the_chat_tool_path() -> None:
    """Anti-vacuity guard: the persisting wrapper still lives in the chat tool
    service, so the route-absence gate above proves a real separation rather than a
    deleted symbol.
    """
    service_src = _WEB_SEARCH_SERVICE.read_text(encoding="utf-8")
    assert "def persist_web_search_run(" in service_src, (
        "persist_web_search_run must remain defined in the chat web_search service"
    )
    assert "persist_web_search_run(db, run)" in service_src, (
        "execute_web_search must remain the sole caller of persist_web_search_run"
    )
