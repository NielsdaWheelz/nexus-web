"""Source-scanning guards for the search intent-model cutover (§14 negative gates).

These assert the structural invariants the cutover established so a future edit that
re-introduces the schema-leaking taxonomy, the semantic toggle, the inline scope
branches, or chat-private multi-scope logic fails CI.
"""

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

# The removed retrieval-mode flag in its parameter / keyword / field forms
# (`semantic:` or `semantic=`). Deliberately does NOT match the legitimate
# vector-similarity vocabulary (semantic_query_embedding, MIN_SEMANTIC_SIMILARITY)
# or prose — hybrid retrieval IS semantic; only the toggle was removed.
_SEMANTIC_FLAG = re.compile(r"\bsemantic\s*[:=]")


def _strip_comments(src: str) -> str:
    return "\n".join(line.split("#", 1)[0] for line in src.splitlines())


ROOT = Path(__file__).resolve().parents[2]
NEXUS = ROOT / "python" / "nexus"
WEB = ROOT / "apps" / "web" / "src"

SEARCH_PKG = NEXUS / "services" / "search"
ROUTE = NEXUS / "api" / "routes" / "search.py"
APP_SEARCH = NEXUS / "services" / "agent_tools" / "app_search.py"
CONVERSATION = NEXUS / "schemas" / "conversation.py"
MODELS = NEXUS / "db" / "models.py"
SEARCH_PANE = WEB / "app" / "(authenticated)" / "search" / "SearchPaneBody.tsx"
PALETTE_CONTROLLER = WEB / "components" / "palette" / "usePaletteController.ts"
E2E = ROOT / "e2e" / "tests"
DOCS = ROOT / "docs"

# Deleted HTTP/URL filter params in their query-string form (`types=` is word-bounded so
# `contentTypes=`/`mimeTypes=` and the like are not flagged).
_LEGACY_URL_PARAM = re.compile(r"\b(content_kinds|contributor_handles|types)=")


def _search_pkg_sources() -> dict[str, str]:
    return {p.relative_to(NEXUS).as_posix(): p.read_text() for p in SEARCH_PKG.rglob("*.py")}


def test_services_search_is_a_package_not_a_single_file() -> None:
    assert not (NEXUS / "services" / "search.py").exists()
    assert (SEARCH_PKG / "__init__.py").exists()


def test_app_search_result_types_is_gone() -> None:
    offenders = [
        p.relative_to(NEXUS).as_posix()
        for p in NEXUS.rglob("*.py")
        if "APP_SEARCH_RESULT_TYPES" in p.read_text()
    ]
    assert offenders == [], f"APP_SEARCH_RESULT_TYPES still referenced: {offenders}"


def test_semantic_axis_is_removed() -> None:
    # Hybrid is an invariant: no `semantic` toggle in the search package, route,
    # the chat tool, or the tool-call SSE payload (the FLAG form, not the vector
    # vocabulary which legitimately remains).
    for name, src in _search_pkg_sources().items():
        assert not _SEMANTIC_FLAG.search(src), f"`semantic` toggle survives in search/{name}"
    assert not _SEMANTIC_FLAG.search(ROUTE.read_text())
    assert "semantic" not in APP_SEARCH.read_text()  # chat tool is fully scrubbed
    assert not _SEMANTIC_FLAG.search(CONVERSATION.read_text())  # SSE payload field gone


def test_no_legacy_filter_params_in_chat_and_route() -> None:
    # §14 scopes this to the chat tool + the route boundary (the internal retrievers
    # legitimately keep `content_kinds` as their storage-kind parameter).
    app = APP_SEARCH.read_text()
    assert "content_kinds" not in app
    assert "contributor_handles" not in app
    route = ROUTE.read_text()
    assert "content_kinds:" not in route  # not declared as an accepted Query param
    assert "contributor_handles:" not in route


def test_route_rejects_deleted_params_and_accepts_new_ones() -> None:
    src = ROUTE.read_text()
    assert "_DELETED_SEARCH_PARAMS" in src
    for deleted in ("types", "content_kinds", "contributor_handles", "semantic"):
        assert f'"{deleted}"' in src  # present only in the rejection tuple/docstring
    for accepted in ("kinds", "formats", "authors", "roles"):
        assert f"{accepted}: str | None = Query(" in src


def test_scope_and_hash_query_not_defined_in_service() -> None:
    src = (SEARCH_PKG / "service.py").read_text()
    assert "def parse_scope" not in src
    assert "def hash_query" not in src


def test_multi_scope_executor_moved_out_of_app_search() -> None:
    assert "_search_across_scopes" not in APP_SEARCH.read_text()
    assert (SEARCH_PKG / "batch.py").exists()
    assert "def search_scopes" in (SEARCH_PKG / "batch.py").read_text()


def test_scope_filter_sql_is_the_single_scope_owner() -> None:
    # scope_filter_sql owns scope→SQL (§4.6); retrievers consume it and must not
    # re-inline scoped branches. (`scope_type == "all"` selecting a CTE is fine.)
    assert "def scope_filter_sql" in (SEARCH_PKG / "scope.py").read_text()
    offenders = []
    for path in (SEARCH_PKG / "retrievers").rglob("*.py"):
        src = path.read_text()
        if "def scope_filter_sql" in src:
            offenders.append(f"{path.name}: redefines scope_filter_sql")
        for scoped in (
            'scope_type == "media"',
            'scope_type == "library"',
            'scope_type == "conversation"',
        ):
            if scoped in src:
                offenders.append(f"{path.name}: inline {scoped}")
    assert offenders == [], f"inline scope-filter branches in retrievers: {offenders}"


def test_gutenberg_is_not_a_search_format() -> None:
    # Gutenberg is provenance, not a format (N10). No gutenberg *format-filter* branch
    # (the SQL string literal) in the search package — the credit-visibility use of the
    # project_gutenberg_catalog_ebook_id column and decision comments are fine.
    for name, src in _search_pkg_sources().items():
        code = _strip_comments(src)
        assert "'gutenberg'" not in code, f"gutenberg format literal in search/{name}"
        assert "'project_gutenberg'" not in code, (
            f"project_gutenberg format literal in search/{name}"
        )


# --- Frontend guards -------------------------------------------------------


def _is_test_file(path: Path) -> bool:
    return path.name.endswith((".test.ts", ".test.tsx"))


def _web_search_sources() -> dict[str, str]:
    # Production source only — test files legitimately reference deleted params to assert
    # their absence, so scanning them would be self-defeating.
    return {
        p.relative_to(WEB).as_posix(): p.read_text()
        for p in (WEB / "lib" / "search").rglob("*.ts")
        if not _is_test_file(p)
    }


def test_frontend_search_lib_has_no_legacy_params() -> None:
    for name, src in _web_search_sources().items():
        assert "content_kinds" not in src, f"content_kinds in lib/search/{name}"
        assert "contributor_handles" not in src, f"contributor_handles in lib/search/{name}"
        assert "resultRowAdapter" not in src, f"resultRowAdapter import in lib/search/{name}"
    assert not (WEB / "lib" / "search" / "resultRowAdapter.ts").exists()


def test_search_pane_has_no_checkbox_wall() -> None:
    src = SEARCH_PANE.read_text()
    assert '<input type="checkbox"' not in src
    assert "resultRowAdapter" not in src


def test_no_legacy_types_param_in_search_frontend() -> None:
    # `\btypes=` is a deleted URL param: it must not appear in the search query model or
    # the search page (which would rebuild a stale link). Production source only.
    sources = {"SearchPaneBody.tsx": SEARCH_PANE.read_text(), **_web_search_sources()}
    for name, src in sources.items():
        assert not _LEGACY_URL_PARAM.search(src), f"legacy URL param in {name}"


def test_palette_controller_has_no_legacy_search_params() -> None:
    # §14: the palette @ lane shares the one query model; it must not reintroduce the
    # deleted params (it builds SearchQuery via searchQueryFromInput, never raw filters).
    src = PALETTE_CONTROLLER.read_text()
    assert "content_kinds" not in src
    assert "contributor_handles" not in src
    assert not _LEGACY_URL_PARAM.search(src)


# --- e2e + docs migration gates (§14: e2e/tests/**, docs/**) ----------------


def test_e2e_suite_has_no_legacy_search_params_or_deleted_ui() -> None:
    # The e2e suite must neither build /search URLs with deleted params nor assert against
    # the deleted checkbox surface (the half-migration AC-1's new chips replaced).
    deleted_ui = (
        '"Result types"',
        '"Content kinds"',
        "CONTENT_KIND_LABELS",
        "Search your Nexus content...",
    )
    offenders: list[str] = []
    for path in E2E.rglob("*.ts"):
        src = path.read_text()
        rel = path.relative_to(ROOT).as_posix()
        offenders += [
            f"{rel}: legacy param {m}=" for m in sorted(set(_LEGACY_URL_PARAM.findall(src)))
        ]
        offenders += [f"{rel}: deleted-UI ref {ui!r}" for ui in deleted_ui if ui in src]
    assert offenders == [], offenders


def test_docs_have_no_legacy_search_deep_links() -> None:
    # No /search?…(types|content_kinds|contributor_handles)= deep-link survives in docs.
    # Scoped to the /search? URL so the authors-directory facet's own `content_kinds` param
    # (a different endpoint's vocabulary) is not flagged; this spec's old→new tables excluded.
    pattern = re.compile(r"/search\?[^\s)`]*\b(?:types|content_kinds|contributor_handles)=")
    offenders: list[str] = []
    for path in DOCS.rglob("*.md"):
        if path.name == "search-intent-model-hard-cutover.md":
            continue
        for match in pattern.finditer(path.read_text()):
            offenders.append(f"{path.relative_to(ROOT).as_posix()}: {match.group(0)}")
    assert offenders == [], offenders


# --- semantic axis: telemetry model (§14 / D-14) ----------------------------


def _message_tool_call_model_block() -> str:
    src = MODELS.read_text()
    start = src.index("class MessageToolCall")
    rest = src[start:]
    end = rest.find("\nclass ", 1)
    return rest if end == -1 else rest[:end]


def test_message_tool_calls_model_has_no_semantic_column() -> None:
    # The semantic axis is dropped from chat telemetry (migration 0140). `semantic`
    # legitimately survives elsewhere in models.py (semantic_status on transcript states,
    # object-search embeddings), so this is scoped to the MessageToolCall table block.
    block = _message_tool_call_model_block()
    assert not _SEMANTIC_FLAG.search(block), "semantic column survives on MessageToolCall"
    assert '"semantic"' not in block
