"""Source-scanning guards for the contributor ownership boundaries (I2, I3, I4, I9, I10).

These assert structural invariants the Authors cutover established, so a future edit that
re-introduces an inversion, a duplicate visibility CTE, or a cross-domain write fails CI.
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

NEXUS = Path(__file__).resolve().parents[1] / "nexus"


def _read(*parts: str) -> str:
    return (NEXUS.joinpath(*parts)).read_text()


def _service_sources() -> dict[Path, str]:
    return {path: path.read_text() for path in NEXUS.rglob("*.py")}


def test_taxonomy_leaf_imports_no_sibling_services() -> None:
    # I2: contributor_taxonomy is a leaf; it must not import up from the entity or junction.
    src = _read("services", "contributor_taxonomy.py")
    assert "from nexus.services.contributors" not in src
    assert "from nexus.services.contributor_credits" not in src


def test_contributors_does_not_import_credits() -> None:
    # I2: the inversion is gone — identity (contributors) no longer imports the junction.
    src = _read("services", "contributors.py")
    assert "from nexus.services.contributor_credits import" not in src


def test_podcast_visibility_cte_lives_only_in_permissions() -> None:
    # I3: the subscriptions-∪-library_entries visibility CTE has exactly one home.
    offenders = [
        path.relative_to(NEXUS).as_posix()
        for path, src in _service_sources().items()
        if path.name != "permissions.py"
        and "FROM podcast_subscriptions" in src
        and "UNION" in src
        and "le.podcast_id" in src
    ]
    assert offenders == [], f"inline podcast-visibility CTE outside permissions.py: {offenders}"


def test_contributors_reads_no_chat_tables() -> None:
    # I4: persisted chat context is read only via chat_context_refs.
    src = _read("services", "contributors.py")
    for table in ("message_retrievals", "message_tool_calls", "chat_prompt_assemblies"):
        assert table not in src


def test_identity_evidence_is_strong_only_and_ignores_source_ref() -> None:
    # I9: only strong authorities assert identity, and source_ref is never identity evidence.
    src = _read("services", "contributor_credits.py")
    start = src.index("def _strong_external_id_evidence")
    end = src.index("\ndef ", start)
    evidence_fn = src[start:end]
    code_only = "\n".join(line.split("#", 1)[0] for line in evidence_fn.splitlines())
    assert "STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES" in code_only
    assert "source_ref" not in code_only  # provenance is never read as identity evidence


def test_contributors_issues_no_object_links_dml() -> None:
    # I10: object_links is mutated through object_links.py only; contributors.py just reads it.
    src = _read("services", "contributors.py")
    for marker in (
        "db.add(ObjectLink",
        "INSERT INTO object_links",
        "UPDATE object_links",
        "DELETE FROM object_links",
    ):
        assert marker not in src
