"""CI-assertable §14 negative gates for the Library-Intelligence AI-native cutover.

Each test greps production code (``python/nexus`` + ``apps/web/src``) and asserts
that a dropped symbol is ABSENT (or, for the anti-over-deletion gates, that a
must-REMAIN symbol is PRESENT). The point of these gates is to keep the hard
cutover from silently regressing — a reintroduced section compiler, a revived
verifier-taxonomy column, or an over-eager deletion of a load-bearing store all
fail here with a file:line pointer.

These are pure repo greps (no DB, no app import), so they run in the unit lane.
Each gate scans ONLY ``python/nexus`` + ``apps/web/src``.

Exclusions (intentional): the drop migrations (repo-root ``migrations/``) and the
Python tests (``python/tests/``) both live OUTSIDE the scanned roots, so they can
never appear in a hit and need no exclusion. The only thing that needs excluding
is the frontend ``*.test.{ts,tsx}`` files, which DO live under apps/web/src and
legitimately name dropped symbols in their own absence assertions.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

# python/tests/ -> python/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_ROOT = _REPO_ROOT / "apps" / "web" / "src"

# The post-split achieved line count of the artifact-head owner was 605. The gate
# threshold is that count plus snug headroom (~15 lines) for small future edits,
# and it MATCHES the number recorded in the spec (§12 S7 / §14) so the enforced
# bar IS the contract. Documented deviation from the spec's earlier aspirational
# ~250: the realistic floor for this module is higher because it carries the
# raw-SQL read-model + freshness CTEs + five public dataclasses + the SERIALIZABLE
# generate/promote transactions + docstrings — all of which are the artifact-head
# owner's genuine, single-owner responsibility (the LLM reduce worker was already
# extracted to ``library_intelligence_reduce``). Splitting further would invent a
# hollow middle layer, which cleanliness.md forbids.
_LIBRARY_INTELLIGENCE_LINE_BUDGET = 620


@dataclass(frozen=True)
class _Hit:
    path: str
    line: int
    text: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.text}"


def _grep(pattern: str, *roots: Path) -> list[_Hit]:
    """Run ``grep -rnE`` for ``pattern`` over ``roots``; return parsed hits.

    grep exits 1 (no matches) or 0 (matches); anything else is a real error.
    """
    existing = [str(root) for root in roots if root.exists()]
    if not existing:
        return []
    result = subprocess.run(
        ["grep", "-rnE", "--", pattern, *existing],
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(f"grep failed for {pattern!r}: {result.stderr}")
    hits: list[_Hit] = []
    for raw in result.stdout.splitlines():
        path, _, rest = raw.partition(":")
        line_str, _, text = rest.partition(":")
        hits.append(_Hit(path=path, line=int(line_str), text=text.strip()))
    return hits


def _filtered(pattern: str, *roots: Path, exclude: re.Pattern[str] | None = None) -> list[_Hit]:
    hits = _grep(pattern, *roots)
    if exclude is None:
        return hits
    return [hit for hit in hits if not exclude.search(hit.path)]


# The gates grep only ``python/nexus`` + ``apps/web/src``. Migrations live at the
# repo-root ``migrations/`` tree and the Python tests at ``python/tests/`` — both
# OUTSIDE the grep roots — so neither can ever appear in a hit; only the frontend
# ``*.test.{ts,tsx}`` files (which DO live under apps/web/src) need excluding.
_FRONTEND_TEST = re.compile(r"\.test\.")


def _fmt(hits: list[_Hit]) -> str:
    return "\n".join(f"  - {hit}" for hit in hits)


# =============================================================================
# Dropped LI tables / column-symbols must be ABSENT in production code
# =============================================================================


def test_dropped_li_tables_absent_in_production():
    pattern = "|".join(
        (
            "library_intelligence_versions",
            "library_source_set_versions",
            "library_source_set_items",
            "library_intelligence_sections",
            "library_intelligence_nodes",
            "library_intelligence_claims",
            "library_intelligence_evidence",
            "library_intelligence_builds",
        )
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"dropped LI tables referenced in production code:\n{_fmt(hits)}"


def test_dropped_version_column_symbols_absent_in_production():
    # Anchored so the allowed Rev-3 symbols (current_revision_id / revision_id)
    # do NOT match parent_revision_id, and source_set_version_id is exact.
    pattern = r"\b(active_version_id|artifact_version|source_set_version_id|parent_revision_id|prompt_version|schema_version)\b"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"dropped version column-symbols referenced in production code:\n{_fmt(hits)}"


def test_deterministic_compiler_symbols_absent():
    # No _compile_sections, no PROMPT_VERSION cache key, no deterministic-section
    # tautology strings.
    pattern = r'_compile_sections|PROMPT_VERSION = "LibraryIntelligence\.V1"|No contradictions have been verified'
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"deterministic-compiler remnants present:\n{_fmt(hits)}"


# =============================================================================
# Verifier / support-state taxonomy must be ABSENT in production code
# =============================================================================


def test_support_state_taxonomy_absent_in_production():
    # NOTE: the spec §14 line also lists the bare token "verifier"; we intentionally
    # do NOT ban it, because the auth JWKS verifier (SupabaseJwksVerifier) and the
    # OAuth-PKCE `verifier` are unrelated, legitimate production uses. The LI/chat
    # claim-verifier taxonomy is fully captured by the symbols below.
    pattern = r"support_state|support_status|AssistantClaimSupportStatus|citation_audit"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"verifier support-state taxonomy present:\n{_fmt(hits)}"


def test_claim_event_values_absent_in_production():
    # The dropped 'claim_evidence' event-type literal must not reappear. We ban
    # only this unambiguous token: a bare ['"]claim['"] grep over the whole tree
    # is over-broad (it would flag legitimate `kind == "claim"` / JWT-claim / UI
    # uses). The precise "no bare 'claim' in the chat_run_events CHECK" guarantee
    # is enforced semantically against the real constraint by the integration test
    # test_chat_run_events_check_drops_claim_keeps_citation_index (test_migrations).
    pattern = r"claim_evidence"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"dead claim_evidence event value present:\n{_fmt(hits)}"


# =============================================================================
# library-chat surface must be ABSENT (one allowed negative-test assertion)
# =============================================================================


def test_library_chat_surface_absent():
    # The only permitted residue is the single negative assertion in
    # paneSecondaryModel.test.ts (proves the surface id is rejected).
    allowed = re.compile(r"paneSecondaryModel\.test\.ts")
    hits = [
        hit
        for hit in _grep(r"LibraryChatTab|library-chat", _WEB_ROOT)
        if not allowed.search(hit.path)
    ]
    assert not hits, f"library-chat surface still referenced:\n{_fmt(hits)}"


# =============================================================================
# No second event-append / run-finalize outside run_kit
# =============================================================================


def test_no_second_event_append_or_finalize_outside_run_kit():
    # No manual-seq _append_event helper anywhere; append/finalize live in run_kit.
    append_hits = _filtered(r"\b_append_event\b", _PY_ROOT, exclude=_FRONTEND_TEST)
    assert not append_hits, f"a second event-append helper exists:\n{_fmt(append_hits)}"

    # append_event/mark_terminal/fail_after_worker_exception must be DEFINED only
    # in run_kit (callers reference run_kit.<fn>, which the `def ` anchor skips).
    def_hits = [
        hit
        for hit in _grep(
            r"^def (append_event|mark_terminal|fail_after_worker_exception)\b", _PY_ROOT
        )
        if not hit.path.endswith("services/run_kit.py")
    ]
    assert not def_hits, f"run-finalize defined outside run_kit:\n{_fmt(def_hits)}"


# =============================================================================
# Anti-over-deletion: must-REMAIN stores + a live consumer each (AC-11)
# =============================================================================


@pytest.mark.parametrize(
    "table",
    [
        "message_retrievals",
        "conversation_references",
        "oracle_reading_passages",
        "object_links",
    ],
)
def test_must_remain_store_has_table_def_and_a_consumer(table: str):
    # The ORM table definition lives in db/models.py …
    model_hits = [hit for hit in _grep(table, _PY_ROOT) if hit.path.endswith("db/models.py")]
    assert model_hits, f"{table} table definition missing from db/models.py"

    # … and at least one live service/route consumer outside models.py exists.
    consumer_hits = [
        hit
        for hit in _grep(table, _PY_ROOT)
        if not hit.path.endswith("db/models.py")
        and "/migrations/" not in hit.path
        and not hit.path.endswith("__init__.py")
    ]
    assert consumer_hits, f"{table} has no live consumer outside the model definition"


# =============================================================================
# Allowed Rev-3 symbols must NOT be flagged (sanity: they exist + are not banned)
# =============================================================================


def test_allowed_rev3_symbols_present_and_unflagged():
    # current_revision_id / revision_id / library_intelligence_artifact_revisions
    # are the Rev-3 model and must NOT be matched by any absence gate above. Prove
    # they're live (present in production) so the gates can never be "tightened"
    # into banning them by accident.
    for symbol in (
        "library_intelligence_artifact_revisions",
        "current_revision_id",
        "revision_id",
    ):
        hits = _grep(re.escape(symbol), _PY_ROOT)
        assert hits, f"expected allowed Rev-3 symbol {symbol} to be present in production"


# =============================================================================
# AC-8 — single citation-render owner (apps/web)
# =============================================================================


def test_reader_citation_color_owner_is_single():
    # readerCitationColorForIndex is referenced only in readerCitation.ts / citations.ts.
    allowed = re.compile(r"conversations/(readerCitation|citations)\.ts$")
    hits = [
        hit
        for hit in _grep(r"readerCitationColorForIndex", _WEB_ROOT)
        if not allowed.search(hit.path) and ".test." not in hit.path
    ]
    assert not hits, f"readerCitationColorForIndex referenced outside its owner:\n{_fmt(hits)}"


def test_reader_citation_data_has_one_constructor():
    # toReaderCitationData (in citations.ts) is the ONLY function that builds a
    # ReaderCitationData; everything else is a type import/annotation. We assert
    # that the only `: ReaderCitationData` *return type* is on toReaderCitationData.
    constructors = [
        hit
        for hit in _grep(r": ReaderCitationData\b", _WEB_ROOT)
        if ".test." not in hit.path
        # Array annotations (ReaderCitationData[]) and Map values are consumers,
        # not constructors — they keep a space/bracket after the type.
        and not re.search(r": ReaderCitationData\[\]", hit.text)
    ]
    # Exactly one: the toReaderCitationData return type in citations.ts.
    assert len(constructors) == 1, (
        f"expected one ReaderCitationData constructor:\n{_fmt(constructors)}"
    )
    assert constructors[0].path.endswith("conversations/citations.ts")
    assert "toReaderCitationData" in constructors[0].text


# =============================================================================
# AC-10 — no polling of the intelligence endpoint (apps/web)
# =============================================================================


def test_intelligence_pane_does_not_poll():
    pane_files = [
        _WEB_ROOT
        / "app"
        / "(authenticated)"
        / "libraries"
        / "[id]"
        / "LibraryIntelligencePane.tsx",
        _WEB_ROOT / "components" / "library" / "useLibraryIntelligenceStream.ts",
    ]
    for pane in pane_files:
        assert pane.exists(), f"expected intelligence pane file {pane}"
    pattern = r"refreshVersion|setInterval|setTimeout|refetchInterval|pollInterval"
    hits = _grep(pattern, *pane_files)
    assert not hits, f"intelligence pane uses a polling primitive (AC-10):\n{_fmt(hits)}"


# =============================================================================
# Line-count gate — the artifact-head owner stays lean
# =============================================================================


def test_library_intelligence_line_count_within_budget():
    path = _PY_ROOT / "services" / "library_intelligence.py"
    line_count = sum(1 for _ in path.open(encoding="utf-8"))
    assert line_count <= _LIBRARY_INTELLIGENCE_LINE_BUDGET, (
        f"library_intelligence.py grew to {line_count} lines "
        f"(budget {_LIBRARY_INTELLIGENCE_LINE_BUDGET}); split a concern out of the "
        f"artifact-head owner rather than raising the budget."
    )
