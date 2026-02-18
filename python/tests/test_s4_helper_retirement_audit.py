"""S4 helper-retirement regression audit.

Static source-level checks that verify deprecated visibility helpers
are absent and canonical split helpers are present. No runtime behavior
changes; catches regression cheaply.
"""

from pathlib import Path

PYTHON_ROOT = Path(__file__).parent.parent / "nexus"


def _scan_python_source(root: Path, pattern: str) -> list[tuple[str, int, str]]:
    """Scan all .py files under root for lines containing pattern.

    Returns list of (filepath, line_number, line_text) tuples.
    """
    hits = []
    for py_file in root.rglob("*.py"):
        for i, line in enumerate(py_file.read_text().splitlines(), start=1):
            if pattern in line:
                hits.append((str(py_file.relative_to(root.parent.parent)), i, line.strip()))
    return hits


class TestDeprecatedHelperAbsence:
    """Verify no deprecated visibility helpers remain in python source."""

    def test_deprecated_visibility_helper_names_absent_from_python_code(self):
        """Deprecated get_*_for_viewer_or_404 helpers must not appear in python/."""
        deprecated_names = [
            "get_conversation_for_viewer_or_404",
            "get_highlight_for_viewer_or_404",
        ]
        for name in deprecated_names:
            hits = _scan_python_source(PYTHON_ROOT, name)
            # Filter out test audit files (this file) and comments
            real_hits = [
                (f, ln, txt) for f, ln, txt in hits if "test_s4_helper_retirement_audit" not in f
            ]
            assert real_hits == [], (
                f"Deprecated helper '{name}' found in production code:\n"
                + "\n".join(f"  {f}:{ln}: {txt}" for f, ln, txt in real_hits)
            )


class TestCanonicalHelperPresence:
    """Verify canonical split helpers exist in the right modules."""

    def test_conversation_helper_split_surfaces_present(self):
        """Both conversation read/write helpers must exist."""
        conversations_path = PYTHON_ROOT / "services" / "conversations.py"
        source = conversations_path.read_text()

        assert "get_conversation_for_visible_read_or_404" in source, (
            "Missing get_conversation_for_visible_read_or_404 in conversations.py"
        )
        assert "get_conversation_for_owner_write_or_404" in source, (
            "Missing get_conversation_for_owner_write_or_404 in conversations.py"
        )

    def test_highlight_helper_split_surfaces_present(self):
        """Both highlight read/write helpers must exist."""
        highlights_path = PYTHON_ROOT / "services" / "highlights.py"
        source = highlights_path.read_text()

        assert "get_highlight_for_visible_read_or_404" in source, (
            "Missing get_highlight_for_visible_read_or_404 in highlights.py"
        )
        assert "get_highlight_for_author_write_or_404" in source, (
            "Missing get_highlight_for_author_write_or_404 in highlights.py"
        )


class TestSearchHelperDependencies:
    """Verify search service uses canonical read helpers, not owner-write helpers."""

    def test_search_read_scope_does_not_depend_on_owner_write_helpers(self):
        """Search service must use can_read_conversation, not owner-write helpers."""
        search_path = PYTHON_ROOT / "services" / "search.py"
        source = search_path.read_text()

        owner_write_helpers = [
            "get_conversation_for_owner_write_or_404",
            "get_highlight_for_author_write_or_404",
        ]
        for name in owner_write_helpers:
            assert name not in source, (
                f"Search service must not depend on owner-write helper '{name}'"
            )

        assert "can_read_conversation" in source, (
            "Search service must use can_read_conversation for scope auth"
        )
