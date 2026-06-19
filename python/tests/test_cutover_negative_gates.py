"""CI-assertable negative gates for finished hard cutovers.

Each test greps production code (``python/nexus`` + ``apps/web/src``) and asserts
that a dropped symbol is ABSENT (or, for the anti-over-deletion gates, that a
must-REMAIN symbol is PRESENT). The point of these gates is to keep hard cutovers
from silently regressing — a reintroduced section compiler, a revived
verifier-taxonomy column, legacy provider-runtime import path, or an over-eager
deletion of a load-bearing store all fail here with a file:line pointer.

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
from dataclasses import dataclass
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

# python/tests/ -> python/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_ROOT = _REPO_ROOT / "apps" / "web" / "src"
# python/scripts (corpus seeds, e2e seed, migration helpers) is production-adjacent
# code that the provenance-graph battery (§18.3) must also scrub.
_SCRIPTS_ROOT = _REPO_ROOT / "python" / "scripts"
_REPO_SCRIPTS_ROOT = _REPO_ROOT / "scripts"
_CURRENT_CITATION_CONTRACT_DOCS = (
    _REPO_ROOT / "docs" / "architecture.md",
    _REPO_ROOT / "docs" / "modules" / "chat.md",
    _REPO_ROOT / "docs" / "modules" / "reader-implementation.md",
    _REPO_ROOT / "docs" / "cutovers" / "notes-pages-evidence-unification-hard-cutover.md",
    _REPO_ROOT / "docs" / "cutovers" / "generation-run-harness-hard-cutover.md",
)

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


def _iter_scan_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    if root.is_file():
        return [] if _skip_scan_file(root) else [root]
    return sorted(path for path in root.rglob("*") if path.is_file() and not _skip_scan_file(path))


def _skip_scan_file(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}


def _grep(pattern: str, *roots: Path) -> list[_Hit]:
    """Run a Python-regex line scan over ``roots``; return parsed hits."""
    rx = re.compile(pattern)
    hits: list[_Hit] = []
    for root in roots:
        for path in _iter_scan_files(root):
            text = path.read_text(encoding="utf-8", errors="ignore")
            for line_no, line in enumerate(text.splitlines(), start=1):
                if rx.search(line):
                    hits.append(_Hit(path=path.as_posix(), line=line_no, text=line.strip()))
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
_FRONTEND_TEST_OR_READER_FIXTURE = re.compile(r"\.test\.|/apps/web/src/lib/reader/__fixtures__/")
_PANE_ROUTE_PSEUDO_RESOURCE_SCHEMES = ("author", "author_handle", "daily", "daily_note")


def _fmt(hits: list[_Hit]) -> str:
    return "\n".join(f"  - {hit}" for hit in hits)


# =============================================================================
# User graph tags hard cutover: tag resources must be ABSENT
# =============================================================================


_USER_GRAPH_TAG_DEAD_PATTERN = (
    r"\bclass\s+Tag\(|__tablename__\s*=\s*['\"]tags['\"]|"
    r"\bnexus\.services\.resource_graph\.tags\b|"
    r"\bfrom nexus\.services\.resource_graph import tags\b|\bgraph_tags\.|"
    r"\b(TAG_TEXT_RE|tag_names_from_text|ref_for_tag_name|uix_tags_user_slug)\b|"
    r"\bfrom nexus\.db\.models import .*Tag\b|\bTag\.(?:id|user_id|name|slug)\b|"
    r"\bselect\(Tag\)|\bTag\(|"
    r"\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tags\b|"
    r"\bResourceRef\(\s*scheme\s*=\s*['\"]tag['\"]|\bscheme\s*==\s*['\"]tag['\"]|"
    r"\bobject_type\s*==\s*['\"]tag['\"]|object\.objectType\s*===\s*['\"]tag['\"]|"
    r"_search_includes\(object_types,\s*['\"]tag['\"]\)|"
    r"objectTypes:\s*\[[^\]]*['\"]tag['\"]|filter:\s*['\"]tag['\"]|"
    r"['\"]tag['\"]\s*:\s*ResourceItemCapability\("
)


def test_user_graph_tag_dead_symbols_absent():
    hits = _filtered(
        _USER_GRAPH_TAG_DEAD_PATTERN,
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"user graph tag support still referenced:\n{_fmt(hits)}"


def test_user_graph_tag_modules_absent():
    rel_path = "python/nexus/services/resource_graph/tags.py"
    assert not (_REPO_ROOT / rel_path).exists(), f"{rel_path} must be deleted"


def test_user_graph_tag_registry_literals_absent():
    cases = [
        "python/nexus/services/resource_graph/refs.py",
        "apps/web/src/lib/resourceGraph/resourceRef.ts",
        "apps/web/src/lib/objectRefs.ts",
        "apps/web/src/lib/resources/resourceKind.ts",
    ]
    hits: list[_Hit] = []
    for rel_path in cases:
        path = _REPO_ROOT / rel_path
        text = path.read_text(encoding="utf-8")
        if re.search(r"['\"]tag['\"]|\btag\s*:", text):
            hits.append(_Hit(path.as_posix(), 1, "tag registry literal"))
    assert not hits, f"user graph tag literal in registries:\n{_fmt(hits)}"


def test_user_graph_tag_scheme_constraints_absent_from_models():
    path = _PY_ROOT / "db" / "models.py"
    text = path.read_text(encoding="utf-8")
    hits: list[_Hit] = []
    for match in re.finditer(r"CheckConstraint\((?P<body>[\s\S]*?)name=", text):
        body = match.group("body")
        if re.search(
            r"\b(resource_scheme|surface_scheme|source_scheme|target_scheme|subject_scheme)\b",
            body,
        ) and re.search(r"['\"]tag['\"]", body):
            hits.append(_Hit(path.as_posix(), text[: match.start()].count("\n") + 1, body.strip()))
    assert not hits, f"user graph tag still allowed by scheme CHECKs:\n{_fmt(hits)}"


def test_oracle_metadata_tags_remain_allowlisted():
    models = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    oracle = (_PY_ROOT / "services" / "oracle.py").read_text(encoding="utf-8")
    assert "ck_oracle_passage_anchors_tags" in models
    assert "ck_oracle_plates_tags_array" in models
    assert "tags = [str(tag) for tag in anchor.tags or []]" in oracle


def test_old_oracle_corpus_vector_store_absent_in_production_code():
    pattern = (
        r"\boracle_corpus_passage\b|\bOracleCorpusPassage\b|\bOracleCorpusWork\b|"
        r"\boracle_corpus_works\b|\boracle_corpus_passages\b|"
        r"\boracle_corpus_images\b|\bOracleCorpusImage\b"
    )
    hits = _filtered(
        pattern,
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        _REPO_SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"old Oracle corpus vector-store symbols present:\n{_fmt(hits)}"


def test_old_oracle_embedding_pipeline_helpers_absent_in_production_code():
    pattern = (
        r"\b(_retrieve_corpus_passages|_corpus_embedding_model|"
        r"_retrieve_user_content_chunks_by_embedding)\b|"
        r"Oracle source corpus is not fully seeded|"
        r"\b(passage_embeddings|image_embeddings)\b"
    )
    hits = _filtered(
        pattern,
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        _REPO_SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"old Oracle embedding pipeline helpers present:\n{_fmt(hits)}"


def test_oracle_cutover_seed_paths_use_owner_apis():
    library_entry_hits = _grep(r"\bLibraryEntry\(", _PY_ROOT, _SCRIPTS_ROOT, _REPO_SCRIPTS_ROOT)
    library_entry_hits = [
        hit
        for hit in library_entry_hits
        if not (
            hit.path.endswith("/python/nexus/db/models.py")
            or hit.path.endswith("/python/nexus/services/library_entries.py")
        )
    ]
    assert not library_entry_hits, (
        "library entries must be written through nexus.services.library_entries:\n"
        f"{_fmt(library_entry_hits)}"
    )

    oracle_plate_hits = _grep(r"\bOraclePlate\(", _PY_ROOT, _SCRIPTS_ROOT, _REPO_SCRIPTS_ROOT)
    oracle_plate_hits = [
        hit
        for hit in oracle_plate_hits
        if not (
            hit.path.endswith("/python/nexus/db/models.py")
            or hit.path.endswith("/python/nexus/services/oracle_plates.py")
        )
    ]
    assert not oracle_plate_hits, (
        "Oracle plates must be written through nexus.services.oracle_plates:\n"
        f"{_fmt(oracle_plate_hits)}"
    )


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
    hits = [
        hit
        for hit in _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
        if not (
            "schema_version" in hit.text
            and "assistant_trust_trail.v1" in hit.text
            and (
                hit.path.endswith("/python/nexus/schemas/conversation.py")
                or hit.path.endswith("/apps/web/src/lib/conversations/types.ts")
                or hit.path.endswith("/apps/web/src/components/chat/useChatMessageUpdates.ts")
            )
        )
    ]
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
# Notes/page hard cutover: no service-level block command surface
# =============================================================================


def test_notes_service_block_command_surface_absent_in_production():
    pattern = r"\b(create_note_block|update_note_block|move_note_block|split_note_block|merge_note_block|delete_note_block|CreateNoteBlockRequest|UpdateNoteBlockRequest|MoveNoteBlockRequest|SplitNoteBlockRequest|LinkedObjectRequest)\b"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"legacy notes block command surface present:\n{_fmt(hits)}"


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
        # conversation_references / oracle_reading_passages / object_links left
        # this list when the resource provenance graph cutover dissolved them
        # into resource_edges. Telemetry stays chat-owned.
        "message_retrievals",
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


def test_li_generated_citations_never_source_from_artifact_head():
    pattern = (
        r"source\s*=\s*ResourceRef\(\s*scheme\s*=\s*['\"]library_intelligence_artifact['\"]|"
        r"source_scheme\s*=\s*['\"]library_intelligence_artifact['\"].*ordinal\s*="
    )
    hits = _filtered(pattern, _PY_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        "Library Intelligence generated citations must source from "
        "library_intelligence_revision, never the mutable artifact head:\n"
        f"{_fmt(hits)}"
    )


def test_li_generate_response_has_no_run_id_alias():
    hits = [
        hit
        for hit in _filtered(
            r"\brun_id\b",
            _PY_ROOT / "api",
            _PY_ROOT / "schemas",
            _WEB_ROOT / "components" / "library",
            exclude=_FRONTEND_TEST,
        )
        if "library_intelligence" in hit.path or "LibraryIntelligence" in hit.path
    ]
    assert not hits, f"LI generate response/run handling revived run_id alias:\n{_fmt(hits)}"


# =============================================================================
# AC-8 — single citation-render owner (apps/web)
# =============================================================================


def test_reader_citation_color_owner_is_single():
    # readerCitationColorForIndex is defined in conversations/readerCitation.ts and
    # consumed only by the relocated citation adapter resourceGraph/citations.ts
    # (the provenance-graph cutover moved the one CitationOut→ReaderCitationData
    # adapter into resourceGraph/, §6/§11.11).
    allowed = re.compile(r"(conversations/readerCitation|resourceGraph/citations)\.ts$")
    hits = [
        hit
        for hit in _grep(r"readerCitationColorForIndex", _WEB_ROOT)
        if not allowed.search(hit.path) and ".test." not in hit.path
    ]
    assert not hits, f"readerCitationColorForIndex referenced outside its owner:\n{_fmt(hits)}"


def test_reader_citation_data_has_one_constructor():
    # toReaderCitationData (the one citation adapter, now in resourceGraph/citations.ts)
    # is the ONLY function that builds a ReaderCitationData; everything else is a type
    # import/annotation. We assert the only `: ReaderCitationData` *return type* is on
    # toReaderCitationData. conversations/citations.ts merely re-exports it.
    constructors = [
        hit
        for hit in _grep(r": ReaderCitationData\b", _WEB_ROOT)
        if ".test." not in hit.path
        # Array annotations (ReaderCitationData[]) and Map values are consumers,
        # not constructors — they keep a space/bracket after the type.
        and not re.search(r": ReaderCitationData\[\]", hit.text)
    ]
    # Exactly one: the toReaderCitationData return type in resourceGraph/citations.ts.
    assert len(constructors) == 1, (
        f"expected one ReaderCitationData constructor:\n{_fmt(constructors)}"
    )
    assert constructors[0].path.endswith("resourceGraph/citations.ts")
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


# #############################################################################
# Generation-run harness (§14) — one LLM substrate for chat / oracle / LI
#
# Same grep idiom as above: each gate scans only python/nexus + apps/web/src and
# asserts a dropped symbol is ABSENT or a must-REMAIN owner is PRESENT. Migrations
# (repo-root migrations/) and python/tests/ live outside the scanned roots and so
# can never appear in a hit; only the frontend *.test.{ts,tsx} files need excluding.
# #############################################################################


def _excluding(hits: list[_Hit], *suffixes: str) -> list[_Hit]:
    """Drop hits whose path ends with one of ``suffixes`` (the gate's allowed owners)."""
    return [hit for hit in hits if not hit.path.endswith(suffixes)]


# =============================================================================
# Pane route resource identity cutover — route locators, not pseudo refs
# =============================================================================


def test_pane_route_pseudo_resource_schemes_absent_from_resource_ref_registries():
    literal_pattern = "|".join(
        rf"['\"]{re.escape(scheme)}['\"]" for scheme in _PANE_ROUTE_PSEUDO_RESOURCE_SCHEMES
    )
    registry_files = [
        _PY_ROOT / "services" / "resource_graph" / "refs.py",
        _PY_ROOT / "services" / "resource_items" / "capabilities.py",
        _WEB_ROOT / "lib" / "resourceGraph" / "resourceRef.ts",
        _WEB_ROOT / "lib" / "resources" / "resourceKind.ts",
    ]
    hits = _grep(literal_pattern, *registry_files)
    assert not hits, f"author/daily pseudo schemes entered ResourceRef registries:\n{_fmt(hits)}"


def test_pane_route_pseudo_resource_schemes_absent_from_scheme_constraints():
    models = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    hits: list[_Hit] = []
    literal_pattern = "|".join(
        rf"['\"]{re.escape(scheme)}['\"]" for scheme in _PANE_ROUTE_PSEUDO_RESOURCE_SCHEMES
    )
    for match in re.finditer(r"CheckConstraint\((?P<body>[\s\S]*?)name=", models):
        body = match.group("body")
        if re.search(
            r"\b(resource_scheme|surface_scheme|source_scheme|target_scheme|subject_scheme)\b",
            body,
        ) and re.search(literal_pattern, body):
            hits.append(
                _Hit(
                    (_PY_ROOT / "db" / "models.py").as_posix(),
                    models[: match.start()].count("\n") + 1,
                    body.strip(),
                )
            )
    assert not hits, f"author/daily pseudo schemes entered ResourceRef CHECKs:\n{_fmt(hits)}"


def test_pane_route_pseudo_resource_refs_not_constructed_as_resource_identity():
    pseudo_ref_pattern = (
        r"ResourceRef\(\s*scheme\s*=\s*['\"](?:author|author_handle|daily|daily_note)['\"]|"
        r"\b(?:parse_resource_ref|assert_resource_ref)\(\s*['\"](?:author|daily|daily_note):|"
        r"\bparseResourceRef\(\s*[`'\"](?:author|daily|daily_note):|"
        r"\bformatResourceRef\(\s*\{[^}\n]*scheme\s*:\s*['\"](?:author|author_handle|daily|daily_note)['\"]|"
        r"\bresourceRef\s*[:=]\s*[`'\"](?:author|daily|daily_note):"
    )
    hits = _filtered(
        pseudo_ref_pattern,
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"author/daily pseudo refs used as ResourceRef identity:\n{_fmt(hits)}"


def test_pane_route_model_does_not_own_semantic_resource_refs():
    path = _WEB_ROOT / "lib" / "panes" / "paneRouteModel.ts"
    hits = _grep(r"\b(resourceRef|canonicalResourceRef|parseResourceRef|ResourceScheme)\b", path)
    assert not hits, (
        "paneRouteModel must stay URL-only; route-to-resource semantics belong "
        f"to pane resource locators and ResourceItemOut:\n{_fmt(hits)}"
    )


def test_pane_route_identity_does_not_expose_legacy_resource_fields():
    path = _WEB_ROOT / "lib" / "panes" / "paneIdentity.ts"
    hits = _grep(r"\b(resourceRef|resourceKey)\b", path)
    assert not hits, (
        "paneIdentity must expose routeKey plus resourceLocator only; resolved "
        f"ResourceItemOut owns resourceRef/resourceKey:\n{_fmt(hits)}"
    )


def test_pane_runtime_provider_does_not_accept_legacy_resource_props():
    path = _WEB_ROOT / "lib" / "panes" / "paneRuntime.tsx"
    hits = _grep(r"\b(?:resourceRef|resourceKey)\?:|@deprecated.*resource", path)
    assert not hits, (
        "PaneRuntimeProvider must not accept legacy resource identity props; "
        f"resource identity is derived from resourceItem only:\n{_fmt(hits)}"
    )


# =============================================================================
# Ledger: message_llm dropped, llm_calls is the only LLM-call store
# =============================================================================


def test_message_llm_absent_from_production():
    # The old chat-only usage table + ORM symbol are gone (rows migrated to
    # llm_calls in migration 0145, which lives outside the scanned roots).
    hits = _filtered(r"\bmessage_llm\b|\bMessageLLM\b", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"message_llm / MessageLLM still referenced in production:\n{_fmt(hits)}"


# =============================================================================
# Worker envelope: one event loop / client / router owner (AC-4)
# =============================================================================


def test_no_event_loop_construction_under_tasks_except_llm_task():
    # asyncio.new_event_loop / run_until_complete live only in tasks/llm_task.py;
    # every other task body runs inside run_llm_task's envelope.
    hits = _grep(r"asyncio\.new_event_loop|run_until_complete", _PY_ROOT / "tasks")
    hits = _excluding(hits, "tasks/llm_task.py")
    assert not hits, f"event-loop construction outside tasks/llm_task.py:\n{_fmt(hits)}"


# =============================================================================
# Key spine: no raw settings.<provider>_api_key reads (AC-5)
# =============================================================================


def test_no_raw_provider_key_reads_outside_key_spine():
    # The platform-key reads live only in llm_catalog.py (which exposes them via
    # platform_key_for_provider) and api_key_resolver.py; config.py owns the
    # settings fields.
    pattern = (
        r"settings\.(anthropic|openai|gemini|openrouter)_api_key|settings\.cloudflare_ai_api_token"
    )
    hits = _excluding(
        _grep(pattern, _PY_ROOT),
        "llm_catalog.py",
        "services/api_key_resolver.py",
        "config.py",
    )
    assert not hits, f"raw provider-key read outside the key spine:\n{_fmt(hits)}"


# =============================================================================
# Shared provider runtime: no direct provider SDK imports or brittle error maps
# =============================================================================


def test_no_direct_provider_sdk_imports_in_nexus():
    # Nexus may import provider_runtime. Direct provider SDK/API substrates belong
    # in the shared runtime package, not in application services.
    pattern = (
        r"^\s*(from|import) (openai|anthropic|groq)\b|"
        r"^\s*from google import genai\b|"
        r"^\s*(from|import) google\.(genai|generativeai)\b|"
        r"^\s*(from|import) pydantic_ai\.(models|providers)\b"
    )
    hits = _filtered(pattern, _PY_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"direct provider SDK import in Nexus production code:\n{_fmt(hits)}"


def test_legacy_llm_calling_imports_absent_from_app_code():
    hits = _filtered(r"\bllm_calling\b|llm-calling", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"legacy llm-calling import path present in app code:\n{_fmt(hits)}"


def test_no_direct_provider_http_endpoints_in_nexus():
    pattern = (
        r"api\.openai\.com|api\.anthropic\.com|"
        r"generativelanguage\.googleapis\.com|openrouter\.ai|api\.cloudflare\.com"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        f"direct provider HTTP endpoint literal in Nexus production code:\n{_fmt(hits)}"
    )


def test_provider_response_cursor_absent_from_app_code():
    hits = _filtered(r"\bprevious_response_id\b", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"provider-stored response cursor present in app code:\n{_fmt(hits)}"


def test_provider_native_reasoning_artifact_fields_absent_from_app_code():
    pattern = (
        r"\bencrypted_content\b|\bredacted_thinking\b|\bthoughtSignature\b|"
        r"\breasoning_content\b|\bThinkingPart\b|\breasoning_summary\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"provider-native reasoning artifact fields in app code:\n{_fmt(hits)}"


def test_provider_runtime_router_import_absent_from_app_code():
    hits = _filtered(r"provider_runtime\.router", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"provider_runtime.router import path present in app code:\n{_fmt(hits)}"


def test_modelchunk_absent_from_nexus_runtime_edges():
    hits = _filtered(r"\bModelChunk\b", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"legacy provider-runtime ModelChunk in app code:\n{_fmt(hits)}"


def test_nexus_owned_llm_request_lowering_absent():
    lowering_path = _PY_ROOT / "services" / "llm_request_lowering.py"
    assert not lowering_path.exists(), f"{lowering_path} must not exist"

    hits = _filtered(
        r"nexus\.services\.llm_request_lowering|lower_llm_request_for_provider",
        _PY_ROOT,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"Nexus-local LLM request lowering referenced:\n{_fmt(hits)}"


def test_removed_deepseek_provider_absent_from_app_code():
    hits = _filtered(
        r"\bdeepseek\b|\bDeepSeek\b",
        _PY_ROOT,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST_OR_READER_FIXTURE,
    )
    assert not hits, f"removed DeepSeek provider referenced in app code:\n{_fmt(hits)}"


def test_provider_runtime_dependency_is_not_editable_sibling_path():
    for relative_path in ("python/pyproject.toml", "python/uv.lock"):
        text = (_REPO_ROOT / relative_path).read_text(encoding="utf-8")
        assert "../../llm-calling" not in text, (
            f"{relative_path} still points provider-runtime at the sibling checkout"
        )
        assert 'editable = "../../llm-calling"' not in text, (
            f"{relative_path} still locks provider-runtime as editable"
        )


def test_live_provider_gate_includes_shared_llm_provider_matrix():
    makefile = (_REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    assert "_test-shared-llm-provider-matrix-raw" in makefile
    assert "tests/live/test_provider_matrix.py" in makefile
    assert "LLM_RUNTIME_LIVE=1" in makefile
    assert "env -u LLM_RUNTIME_LIVE_PROVIDERS" in makefile
    assert "_test-provider-runtime-raw" in makefile
    assert "uv run ruff check src tests" in makefile
    assert "uv run pyright src tests" in makefile
    assert "uv run pytest -q" in makefile
    assert "python/pyproject.toml" in makefile
    assert "rev-parse HEAD" in makefile

    workflow = (_REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "test-provider-runtime:" in workflow
    assert "LLM_CALLING_DIR: llm-calling" in workflow
    assert "Resolve provider-runtime revision" in workflow
    assert "repository: NielsdaWheelz/llm-calling" in workflow
    assert "ref: ${{ steps.provider-runtime.outputs.rev }}" in workflow
    assert "Test pinned provider-runtime" in workflow
    assert "Check live-provider secrets" in workflow
    assert "live_ready=false" in workflow
    assert "Live-provider gate not run" in workflow
    assert "This CI run is not live-provider proof" in workflow
    assert "Test live-provider gate" in workflow
    assert "if: steps.live-provider-secrets.outputs.live_ready == 'true'" in workflow
    for secret in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "CLOUDFLARE_AI_API_TOKEN",
        "CLOUDFLARE_AI_ACCOUNT_ID",
        "PODCAST_INDEX_API_KEY",
        "PODCAST_INDEX_API_SECRET",
        "DEEPGRAM_API_KEY",
        "YOUTUBE_DATA_API_KEY",
        "X_API_BEARER_TOKEN",
        "X_LIVE_TEST_POST_URL",
        "X_LIVE_TEST_EXPECTED_TEXT",
    ):
        assert f"secrets.{secret}" in workflow


def test_raw_model_runtime_calls_stay_inside_ledger_or_explicit_exceptions():
    # Generation paths must call providers through llm_ledger. The explicit
    # exceptions are structured_synthesis' ledgered interface and saved-key probes.
    hits = _excluding(
        _grep(
            r"\b(?:router|llm_router|runtime|llm|model_runtime|provider_runtime|provider_router)\.(?:generate|stream)\(",
            _PY_ROOT,
        ),
        "services/llm_ledger.py",
        "services/structured_synthesis.py",
        "services/user_keys.py",
    )
    assert not hits, f"raw ModelRuntime generate/stream call outside ledger owners:\n{_fmt(hits)}"


def test_chat_stream_legacy_event_literals_absent_from_chat_owners():
    roots = (
        _PY_ROOT / "schemas" / "conversation.py",
        _PY_ROOT / "services" / "chat_runs.py",
        _PY_ROOT / "services" / "chat_run_event_store.py",
        _PY_ROOT / "services" / "chat_run_response.py",
        _WEB_ROOT / "components" / "chat",
        _WEB_ROOT / "lib" / "api" / "sse" / "events.ts",
        _WEB_ROOT / "lib" / "conversations" / "types.ts",
    )
    hits = _filtered(
        r"['\"](?:delta|tool_call|retrieval_result)['\"]",
        *roots,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"legacy chat stream event literal in chat owner:\n{_fmt(hits)}"


def test_chat_run_events_check_is_new_stream_grammar_only():
    src = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    start = src.index("class ChatRunEvent(Base):")
    body = src[start : src.index("\nclass ", start + 1)]
    match = re.search(
        r"CheckConstraint\((?P<check>[\s\S]*?)name=\"ck_chat_run_events_event_type\"",
        body,
    )
    assert match is not None, "chat_run_events event_type CHECK is missing"
    check = match.group("check")
    for event_type in (
        "meta",
        "assistant_activity",
        "assistant_text_delta",
        "tool_call_start",
        "tool_call_delta",
        "tool_call_done",
        "tool_result",
        "citation_index",
        "context_ref_added",
        "done",
    ):
        assert f"'{event_type}'" in check, f"chat_run_events CHECK missing {event_type}"
    for old_event_type in ("'delta'", "'tool_call'", "'retrieval_result'"):
        assert old_event_type not in check, f"chat_run_events CHECK still allows {old_event_type}"


def test_chat_tail_resume_uses_event_sequence_not_text_length():
    src = (_WEB_ROOT / "components" / "chat" / "useChatRunTail.ts").read_text(encoding="utf-8")
    assert "folded_event_seq" in src, "chat tail is not resuming from server event cursor"
    assert "initialAfter" in src, "chat tail is not passing the server cursor to SSE transport"
    assert "conversationMessageText" not in src
    assert "replayDeltaCharsToSkip" not in src


def test_frontend_chat_model_policy_has_no_static_provider_or_model_literals():
    pattern = (
        r"PROVIDER_ORDER|DEFAULT_MODEL|DEFAULT_CHAT_MODEL|providerOrder|"
        r"gpt-|claude-|gemini-|moonshotai|@cf/|openrouter|anthropic|openai|cloudflare"
    )
    hits = _filtered(
        pattern,
        _WEB_ROOT / "components" / "chat",
        _WEB_ROOT / "lib" / "conversations",
        exclude=_FRONTEND_TEST,
    )
    assert not hits, (
        f"frontend chat model policy contains static provider/model literals:\n{_fmt(hits)}"
    )


def test_llm_error_code_mapping_is_not_indexed_directly():
    # Unknown shared-runtime error codes should degrade through
    # api_error_code_for_model_call instead of raising KeyError.
    hits = _filtered(r"LLM_ERROR_CODE_TO_API_ERROR_CODE\[", _PY_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"direct LLM error-code map indexing in production code:\n{_fmt(hits)}"


# =============================================================================
# SERIALIZABLE retries: one owner, db/retries.py (no hand-rolled loops)
# =============================================================================


def test_no_serializable_retry_loop_outside_db_retries():
    # The retry constant and the manual loop both collapsed into retry_serializable.
    const_hits = _filtered(r"\b_SERIALIZABLE_RETRIES\b", _PY_ROOT, exclude=_FRONTEND_TEST)
    assert not const_hits, f"_SERIALIZABLE_RETRIES constant resurrected:\n{_fmt(const_hits)}"

    # is_serialization_failure is referenced only where the loop is defined
    # (db/retries.py) and where the predicate itself lives (db/errors.py).
    loop_hits = _excluding(
        _grep(r"is_serialization_failure", _PY_ROOT), "db/retries.py", "db/errors.py"
    )
    assert not loop_hits, f"serialization-failure loop outside db/retries.py:\n{_fmt(loop_hits)}"


# =============================================================================
# Synthesis scaffold: the RULES/closing literals live only in one owner
# =============================================================================


def test_synthesis_prompt_literals_only_in_scaffold():
    # The shared strict-JSON wording is owned by structured_synthesis.py; the three
    # call sites pass domain rules, never re-spell these closing lines.
    pattern = r"No markdown fences, no extra keys|Respond with the strict JSON object"
    hits = _excluding(_grep(pattern, _PY_ROOT), "services/structured_synthesis.py")
    assert not hits, f"synthesis prompt literal outside structured_synthesis.py:\n{_fmt(hits)}"


# =============================================================================
# Oracle: BE failure-message map + 'error' event type deleted (normalized done)
# =============================================================================


def test_oracle_failure_symbols_absent():
    # Oracle failures now route through run_kit.mark_terminal + done{status,error_code};
    # the BE copy map and the read-time event rewrite are gone (FE owns oracle copy).
    pattern = r"_oracle_failure_message|_oracle_event_out|ORACLE_LLM_CONFIGURATION_MESSAGE"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"oracle failure-message symbols present:\n{_fmt(hits)}"


def test_oracle_error_event_type_absent_in_writers():
    # No 'error' / "error" event-type literal in the oracle service or its route.
    # The DB CHECK forbidding it is asserted semantically in test_migrations
    # (0146 drops 'error' from ck_oracle_reading_events_type).
    oracle_files = (_PY_ROOT / "services" / "oracle.py", _PY_ROOT / "api" / "routes" / "oracle.py")
    hits = _grep(r"""["']error["']""", *oracle_files)
    assert not hits, f"oracle 'error' event literal present in a writer:\n{_fmt(hits)}"


# =============================================================================
# Stream plane: every browser stream lives under /stream/ (AC-8)
# =============================================================================


def test_stream_paths_predicate_is_a_prefix_check():
    # stream_paths.is_stream_path is one prefix check — no per-kind startswith arm.
    hits = _grep(r'startswith\("/chat-runs/"\)', _PY_ROOT)
    assert not hits, f"per-kind chat-runs arm in the stream-path predicate:\n{_fmt(hits)}"


def test_event_stream_path_literals_are_under_stream_prefix():
    # A /chat-runs/.../events or /media/.../events path literal is only legal as the
    # /stream/ route; the old off-prefix stream paths are removed. (The non-event
    # /chat-runs/{id} + /cancel chat routes do not match this events-bearing pattern.)
    pattern = r"/(chat-runs|media)/[^\"']*events"
    off_prefix = [
        hit
        for hit in _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
        if "/stream/" not in hit.text
    ]
    assert not off_prefix, f"event-stream path literal not under /stream/:\n{_fmt(off_prefix)}"


# =============================================================================
# Citations: one message_retrievals writer (AC-10)
# =============================================================================


def test_message_retrievals_insert_only_in_retrieval_citation():
    # web_search no longer hand-rolls retrieval SQL; insert_retrieval_row is the
    # sole writer (the INSERT lives in retrieval_citation.py).
    hits = _excluding(
        _grep(r"INSERT INTO message_retrievals", _PY_ROOT), "services/retrieval_citation.py"
    )
    assert not hits, f"message_retrievals INSERT outside retrieval_citation.py:\n{_fmt(hits)}"


def test_standalone_message_ledger_inspection_routes_are_deleted():
    banned = (
        "retrieval-candidate-ledgers",
        "rerank-ledgers",
        "verifier-runs",
        "api/routes/message_retrievals.py",
        "services/message_retrievals.py",
    )
    hits = _filtered("|".join(re.escape(item) for item in banned), _PY_ROOT, _WEB_ROOT)
    allowed_docs = [
        hit
        for hit in hits
        if hit.path.endswith("docs/cutovers/assistant-message-trust-trail-hard-cutover.md")
    ]
    live_hits = [hit for hit in hits if hit not in allowed_docs]
    assert not live_hits, f"standalone ledger inspection route survived:\n{_fmt(live_hits)}"


# =============================================================================
# Dead-symbol sweep (generation-run harness consolidations)
# =============================================================================


def test_generation_harness_dead_symbols_absent():
    # charge_token_budget (dead RateLimiter method), _unread_stream_api_error_code
    # (nexus router-exception patch, superseded by the provider_runtime catch widening),
    # and generator_model_id (dropped oracle column) are all gone.
    pattern = r"charge_token_budget|_unread_stream_api_error_code|generator_model_id"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"generation-harness dead symbol present:\n{_fmt(hits)}"


# =============================================================================
# AC-2 — every catalog entry offers "default" reasoning
# =============================================================================


def test_every_catalog_model_offers_default_reasoning():
    # Importing the catalog is allowed (pure data, no DB); the FE defaults to
    # "default" for every model, so every entry must accept it.
    from nexus.llm_catalog import MODEL_CATALOG

    missing = [
        f"{entry.provider}/{entry.model_name}"
        for entry in MODEL_CATALOG
        if "default" not in entry.reasoning_modes
    ]
    assert not missing, f"catalog entries missing 'default' reasoning mode: {missing}"


# =============================================================================
# AC-6 — DEFAULT_WORKER_ALLOWED_JOB_KINDS has no unknown kinds and covers
# USER_FACING_JOB_KINDS
#
# The authoritative guard already lives in test_config.py
# (test_default_worker_allowlist_matches_registry_and_user_facing_jobs). It is
# restated here as a §14 gate so the negative-gate suite is self-contained; both
# must hold.
# =============================================================================


def test_worker_allowlist_kinds_match_registry_and_user_facing_jobs():
    from nexus.config import DEFAULT_WORKER_ALLOWED_JOB_KINDS
    from nexus.jobs.registry import USER_FACING_JOB_KINDS, get_default_registry

    allowed = {kind.strip() for kind in DEFAULT_WORKER_ALLOWED_JOB_KINDS.split(",") if kind.strip()}
    unknown = allowed - set(get_default_registry())
    missing = set(USER_FACING_JOB_KINDS) - allowed
    assert not unknown, f"worker allowlist kinds not in the registry: {sorted(unknown)}"
    assert not missing, f"user-facing job kinds not in the worker allowlist: {sorted(missing)}"


# =============================================================================
# Must-REMAIN (anti-over-deletion) for the generation-run harness
# =============================================================================


def test_generation_harness_must_remain_symbols_present():
    # Both SSE tailers stay (the two-tailer defense in _sse.py); the one token
    # estimator stays (char *budgets* are domain and orthogonal); chat keeps its
    # user-copy map. (message_retrievals presence — the one chat-owned telemetry
    # store that survives — is covered by the parametrized must-REMAIN gate above;
    # conversation_references/oracle_reading_passages/object_links were folded into
    # resource_edges by the provenance-graph cutover and are now BANNED by the
    # §18.3 dropped-symbol gates below.)
    for symbol, where in (
        ("tail_cursor_stream", _PY_ROOT),
        ("tail_snapshot_stream", _PY_ROOT),
        ("ERROR_CODE_TO_MESSAGE", _PY_ROOT),
    ):
        assert _grep(re.escape(symbol), where), f"must-REMAIN symbol {symbol} is absent"

    # prompt_budget.estimate_tokens is the one reservation estimator.
    estimator = [
        hit
        for hit in _grep(r"def estimate_tokens\b", _PY_ROOT / "services")
        if hit.path.endswith("services/prompt_budget.py")
    ]
    assert estimator, "prompt_budget.estimate_tokens is absent"


# =============================================================================
# Frontend generation-run client (§14 FE gates)
#
# TWO DOCUMENTED DIVERGENCES from the spec's §14 wording — the gate INTENT holds,
# but the literal assertions are adjusted to the implemented reality:
#
#   1. fetchStreamToken is NOT confined to sse-client.ts, and the transport is not
#      opened per surface. The single non-hook transport opener —
#      openGenerationRunStream in useGenerationRun.ts — performs the one token mint
#      + URL build + sseClientDirect call; both useGenerationRun (the single-id
#      hook) and useChatRunTail (the multi-run imperative tailer) delegate to it.
#      So fetchStreamToken and sseClientDirect are each CALLED from exactly one
#      non-test caller (the opener); their definition modules (streamToken.ts,
#      sse-client.ts — the latter also mints on its own reconnects) reference them
#      too. No oracle/library/media surface, and not chat, re-implements the
#      transport. We assert that.
#
#   2. lib/api/sse/citations.ts is NOT deleted (the spec mislabeled it as the
#      citation_index validator). It validates the SURVIVING retrieval_result SSE
#      event (tool-results display). The citation RENDER reconstruction — the
#      messageToCitationOuts family + the 526-line CitationOut rebuild — IS deleted.
#      The live citation_index payload hard cutover is pinned separately; this
#      gate only asserts the render reconstruction family stays absent.
# =============================================================================

# The shared transport primitives — minting a stream token and opening an SSE
# connection — are CALLED from exactly one non-test caller: openGenerationRunStream
# in useGenerationRun.ts. Their definition modules reference them too (streamToken.ts
# defines fetchStreamToken; sse-client.ts defines sseClientDirect and mints fresh
# tokens on its own reconnects). Any other file re-implementing the transport (an
# oracle/library/media pane, or chat) would resurrect the duplication F01 removed.
_TRANSPORT_PRIMITIVE_OWNERS = (
    "lib/api/streamToken.ts",
    "lib/api/sse-client.ts",
    "lib/api/useGenerationRun.ts",
)


def test_sse_transport_primitives_have_one_caller_not_per_surface():
    # Divergence 1: fetchStreamToken + sseClientDirect are used only inside their
    # definition modules and the one opener — never re-implemented per surface.
    hits = _excluding(
        [
            hit
            for hit in _grep(r"\bfetchStreamToken\b|\bsseClientDirect\b", _WEB_ROOT)
            if ".test." not in hit.path
        ],
        *_TRANSPORT_PRIMITIVE_OWNERS,
    )
    assert not hits, f"SSE transport primitive used outside the one opener:\n{_fmt(hits)}"

    # ...and the opener IS that one caller (guard against the gate going vacuous if
    # openGenerationRunStream is ever deleted or stops calling the primitives).
    opener_src = (_WEB_ROOT / "lib" / "api" / "useGenerationRun.ts").read_text()
    assert "fetchStreamToken" in opener_src, "openGenerationRunStream no longer mints the token"
    assert "sseClientDirect" in opener_src, "openGenerationRunStream no longer opens the stream"


def test_citation_render_reconstruction_family_absent():
    # Divergence 2: the FE-side CitationOut render reconstruction family is gone.
    pattern = (
        r"messageToCitationOuts|citationIndexFromBlocks|targetRefFromRetrieval|retrievalBlocksOf"
    )
    hits = [hit for hit in _grep(pattern, _WEB_ROOT) if ".test." not in hit.path]
    assert not hits, f"FE citation-render reconstruction family still present:\n{_fmt(hits)}"


def test_citation_snapshot_summary_md_is_schema_aligned():
    backend_src = (_PY_ROOT / "schemas" / "citation.py").read_text(encoding="utf-8")
    frontend_src = (_WEB_ROOT / "lib" / "conversations" / "citationOut.ts").read_text(
        encoding="utf-8"
    )

    assert re.search(r"class CitationSnapshot\b[\s\S]*\bsummary_md\b", backend_src), (
        "backend CitationSnapshot no longer exposes summary_md; update the frontend "
        "CitationSnapshot guard and this gate together"
    )
    assert "summary_md?: string | null" in frontend_src, (
        "frontend CitationSnapshot type is missing backend summary_md"
    )
    assert (
        '"summary_md"' in frontend_src and "isOptionalString(value.summary_md)" in frontend_src
    ), (
        "frontend CitationSnapshot guard must allow backend summary_md and keep extra fields forbidden"
    )


def test_current_docs_do_not_put_page_id_in_public_note_block_offsets_locator():
    hits = _grep(
        r"note_block_offsets\.page_id|note_block_offsets[\"'][^`\n}]*[\"']page_id",
        *_CURRENT_CITATION_CONTRACT_DOCS,
    )
    assert not hits, (
        f"current-state docs must keep public note_block_offsets page-free:\n{_fmt(hits)}"
    )


def test_stream_events_with_reconnect_absent():
    # Oracle's bespoke reconnect loop collapsed into the extended sseClientDirect.
    hits = [
        hit for hit in _grep(r"streamEventsWithReconnect", _WEB_ROOT) if ".test." not in hit.path
    ]
    assert not hits, f"streamEventsWithReconnect still present:\n{_fmt(hits)}"


def test_optional_string_has_one_definition():
    # The five optionalString variants collapsed to one in lib/api/sse/guards.ts.
    definitions = [
        hit
        for hit in _grep(r"(export )?function optionalString\b|const optionalString\b", _WEB_ROOT)
        if ".test." not in hit.path
    ]
    assert len(definitions) == 1, f"expected one optionalString definition:\n{_fmt(definitions)}"
    assert definitions[0].path.endswith("lib/api/sse/guards.ts")


# =============================================================================
# Resource-provenance-graph cutover §18.3 — dropped symbols must be ABSENT
# =============================================================================
#
# The flat-edge cutover dissolves the per-feature link/reference/citation stores
# into ``resource_edges``. Each dropped table/column/verb/param below must be
# gone from ALL production-adjacent code — ``python/nexus`` + ``apps/web/src`` +
# ``python/scripts`` — so a revived store, a re-added relation verb, or a stale
# ``citation_ordinal`` read fails here with a file:line pointer.
#
# Caveats baked into the patterns (spec §18.3 + this batch's notes):
#   - Tokens are word-anchored (``\b``). That is load-bearing for two collisions:
#     ``\bcitation_ordinal\b`` does NOT match the NEW ``uq_resource_edges_citation_ordinal``
#     constraint name or the ``duplicate_citation_ordinal`` log key (``_`` is a word
#     char, so there is no boundary inside ``edges_citation_ordinal``), and
#     ``\bhas_reference\b`` does NOT match the live ``has_context_ref`` query param.
#   - ``span:`` / ``chunk:`` are deliberately NOT grepped: a bare scheme grep
#     false-matches ``lambda span:``, ``evidence_span:``, ``content_chunk:``, and
#     f-strings. Alias rejection (D2) is proven directly by the ResourceRef parse
#     test ``test_resource_graph_refs.test_assert_resource_ref_raises_on_invalid_input``.
#   - Production comments and docstrings are part of the hard-cutover contract:
#     stale store names are allowed only in tests, migrations, and historical docs
#     outside these production roots.
#
# These gates go green only once the parallel dead-code removals land; they are
# written to the cutover's done-state, not its in-progress state.

# Word-anchored tokens for the dropped stores / columns / verbs / params (§0, §13.2,
# §5.7, §10.1). ``object_links`` carries its dead taxonomy (relation verbs + the
# ``OBJECT_LINK_RELATIONS`` symbol) with it.
_DROPPED_GRAPH_SYMBOLS: tuple[str, ...] = (
    "conversation_references",
    "oracle_reading_passages",
    "object_links",
    "library_intelligence_citations",
    "relation_type",
    "note_about",
    "citation_ordinal",
    "has_reference",
    "OBJECT_LINK_RELATIONS",
)


def _is_allowed_graph_residue(hit: _Hit) -> bool:
    # Frontend absence-assertion tests legitimately name dropped symbols.
    if _FRONTEND_TEST.search(hit.path):
        return True
    # Reader apparatus owns source-local extraction ordinals while projecting
    # source-authored citations into graph edges; this is not the removed graph
    # relationship field. Fixture JSON records that source-local extraction
    # payload for deterministic parser tests.
    if "citation_ordinal" in hit.text and (
        hit.path.endswith("/python/nexus/services/reader_apparatus.py")
        or "/apps/web/src/lib/reader/__fixtures__/" in hit.path
    ):
        return True
    return False


@pytest.mark.parametrize("symbol", _DROPPED_GRAPH_SYMBOLS)
def test_dropped_provenance_graph_symbols_absent_in_production(symbol: str):
    hits = [
        hit
        for hit in _grep(rf"\b{symbol}\b", _PY_ROOT, _WEB_ROOT, _SCRIPTS_ROOT)
        if not _is_allowed_graph_residue(hit)
    ]
    assert not hits, (
        f"dropped provenance-graph symbol {symbol!r} still referenced in production-"
        f"adjacent code (it dissolved into resource_edges; spec §18.3):\n{_fmt(hits)}"
    )


# =============================================================================
# §18.3 file-absence — dropped service + route modules must be gone
# =============================================================================


@pytest.mark.parametrize(
    "rel_path",
    [
        # The per-feature link/reference CRUD services and their route modules are
        # deleted; user links + context refs now live on the graph routes.
        "python/nexus/services/conversation_references.py",
        "python/nexus/services/object_links.py",
        "python/nexus/api/routes/conversation_references.py",
        "python/nexus/api/routes/object_links.py",
    ],
)
def test_dropped_provenance_graph_modules_absent(rel_path: str):
    path = _REPO_ROOT / rel_path
    assert not path.exists(), (
        f"{rel_path} must be deleted in the provenance-graph cutover "
        "(its concern moved to services/resource_graph/* + the graph routes)"
    )


def test_no_parallel_resource_graph_vocabulary_in_production():
    pattern = (
        r"\b(object_graph|object_graph_edges|resource_graph_edges|resource_links|"
        r"resource_link_edges|link_edges|graph_edges)\b|object-graph|resource-links"
    )
    hits = _filtered(
        pattern,
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"parallel graph/link vocabulary referenced:\n{_fmt(hits)}"


def test_resource_edge_durable_writes_stay_in_graph_owner():
    pattern = (
        r"\bResourceEdge\(|\b(insert|update|delete)\(ResourceEdge\)|"
        r"\b(INSERT INTO|UPDATE|DELETE FROM|insert into|update|delete from) resource_edges\b"
    )
    hits = _excluding(
        _grep(
            pattern,
            _PY_ROOT,
            _SCRIPTS_ROOT,
        ),
        "db/models.py",
        "services/resource_graph/edges.py",
        "services/resource_graph/adjacency.py",
        "services/resource_graph/cleanup.py",
    )
    assert not hits, f"direct resource_edges write outside resource_graph owner:\n{_fmt(hits)}"


_DROPPED_CONTEXT_SPINE_SYMBOLS: tuple[str, ...] = (
    "conversation_media",
    "initial_references",
    "reference_added",
    "references_added",
    "ConversationReferences",
    "ReferenceChatList",
    "ReferencingChat",
    "useConversationReferences",
    "useChatsByReference",
)


@pytest.mark.parametrize("symbol", _DROPPED_CONTEXT_SPINE_SYMBOLS)
def test_dropped_context_spine_symbols_absent_in_production(symbol: str):
    hits = _filtered(rf"\b{symbol}\b", _PY_ROOT, _WEB_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        f"dropped context-spine symbol {symbol!r} still referenced in production-"
        f"adjacent code:\n{_fmt(hits)}"
    )


def test_context_ref_phrase_drift_absent_in_production():
    pattern = (
        r"\bconversation references?\b|"
        r"\breference-added\b|"
        r"\breferences surface\b|"
        r"\binitial references?\b|"
        r"\battached references?\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"stale context-ref vocabulary in production-adjacent code:\n{_fmt(hits)}"


def test_app_search_does_not_query_resource_edges_directly():
    path = _PY_ROOT / "services" / "agent_tools" / "app_search.py"
    text = path.read_text(encoding="utf-8")
    assert "resource_edges" not in text, (
        "app_search must use resource_graph.context for graph-derived scopes; "
        "direct resource_edges reads fork the search admission contract."
    )


# =============================================================================
# Resource capability registry cutover — one capability owner, one route owner
# =============================================================================

_RESOURCE_CAPABILITY_OWNER_SUFFIXES = (
    "services/resource_items/capabilities.py",
    "services/resource_items/routing.py",
)

_RESOURCE_ROUTE_LITERAL = re.compile(
    r"(?:return|route\s*=)\s*f?[\"']/"
    r"(?:media|libraries|pages|notes|conversations|podcasts|oracle)/"
)


def _is_resource_capability_owner(hit: _Hit) -> bool:
    return hit.path.endswith(_RESOURCE_CAPABILITY_OWNER_SUFFIXES)


def test_resource_ref_route_builders_live_only_in_capability_owner():
    hits: list[_Hit] = []
    helper_pattern = re.compile(r"\bdef\s+(?:_?route_for_ref|_?href_for_ref|_read_pointer_route)\b")

    for path in _iter_scan_files(_PY_ROOT):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "ResourceRef" not in text:
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            if helper_pattern.search(line) or _RESOURCE_ROUTE_LITERAL.search(line):
                hit = _Hit(path=path.as_posix(), line=line_no, text=line.strip())
                if not _is_resource_capability_owner(hit):
                    hits.append(hit)

    assert not hits, (
        "ResourceRef browser-route construction must have one backend owner "
        "(resource_items.capabilities/routing); feature-local route builders "
        f"fork routeability policy:\n{_fmt(hits)}"
    )


def test_local_resource_capability_lists_absent_outside_capability_owner():
    backend_policy_lists = _grep(
        r"\b(?:"
        r"RESOURCE_ITEM_CAPABILITIES|READABLE_RESOURCE_SCHEMES|SCOPE_ONLY_RESOURCE_SCHEMES|"
        r"APP_SEARCH_SCOPE_SCHEMES|CONVERSATION_SEARCH_SCOPE_SCHEMES|"
        r"CITABLE_RESOURCE_RESULT_TYPES|CITATION_OUTPUT_SOURCE_SCHEMES|"
        r"LINKABLE_RESOURCE_SCHEMES|ATTACHABLE_RESOURCE_SCHEMES|"
        r"CHAT_SUBJECT_RESOURCE_SCHEMES"
        r")\b\s*(?::|=)",
        _PY_ROOT,
    )
    backend_hits = [hit for hit in backend_policy_lists if not _is_resource_capability_owner(hit)]

    frontend_hits = _filtered(
        r"\b(?:RESOURCE_SCHEME_OBJECT_TYPES|SCOPE_RE|SYNAPSE_SCANNABLE_TYPES)\b\s*(?::|=)",
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )

    hits = backend_hits + frontend_hits
    assert not hits, (
        "resource capability policy lists must not be hand-authored outside the "
        "capability owner or its generated frontend projection:\n"
        f"{_fmt(hits)}"
    )


# =============================================================================
# Notes/pages object-graph cutover — storage/order belongs to resource_edges
# =============================================================================


def test_notes_pages_object_graph_old_note_structure_absent_in_production():
    # The editor DTO may still project parent/order fields, and content_blocks has a
    # legitimate parent_block_id. This gate targets only the old physical NoteBlock
    # fields and note_blocks table columns that 0148 drops.
    object_graph_hits = _filtered(
        r"\bobject_graph_edges\b", _PY_ROOT, _WEB_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST
    )
    assert not object_graph_hits, (
        f"parallel object_graph_edges table referenced:\n{_fmt(object_graph_hits)}"
    )

    orm_hits = _filtered(
        r"\bNoteBlock\.(?:page_id|parent_block_id|order_key|collapsed)\b",
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not orm_hits, f"old NoteBlock structure fields referenced:\n{_fmt(orm_hits)}"

    sql_hits = _filtered(
        r"\bnote_blocks\b[^\n]*(?:\bpage_id\b|\bparent_block_id\b|\border_key\b|\bcollapsed\b)|(?:\bpage_id\b|\bparent_block_id\b|\border_key\b|\bcollapsed\b)[^\n]*\bnote_blocks\b",
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not sql_hits, (
        f"runtime SQL references dropped note_blocks structure columns:\n{_fmt(sql_hits)}"
    )


def test_public_resource_graph_edge_create_does_not_accept_order_keys():
    # Ordered adjacency is written by the resource adjacency service, not by the
    # generic public edge API/client.
    schema_src = (_PY_ROOT / "schemas" / "resource_graph.py").read_text(encoding="utf-8")
    request_block = schema_src.split("class CreateEdgeRequest", 1)[1].split("\n\nclass ", 1)[0]
    assert "source_order_key" not in request_block
    assert "target_order_key" not in request_block

    client_src = (_WEB_ROOT / "lib" / "resourceGraph" / "edges.ts").read_text(encoding="utf-8")
    create_block = client_src.split("export async function createUserEdge", 1)[1].split(
        "export async function deleteUserEdge", 1
    )[0]
    assert "source_order_key" not in create_block
    assert "target_order_key" not in create_block


# =============================================================================
# Incoming reader connections cutover — one graph read model + one sidecar layout
# =============================================================================


def test_incoming_connections_legacy_read_surfaces_absent_in_production():
    hits = _filtered(
        r"\blistEdgesForRef\b|\blist_edges_for_ref\b|\breverse_citations\b",
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"legacy reverse-connection read surface referenced:\n{_fmt(hits)}"


def test_incoming_connections_old_routes_and_note_component_absent():
    rel_paths = [
        "apps/web/src/components/notes/NoteBacklinks.tsx",
        "apps/web/src/components/notes/NoteBacklinks.module.css",
        "apps/web/src/app/api/object-links",
        "apps/web/src/app/api/object-graph",
        "python/nexus/api/routes/object_links.py",
        "python/nexus/api/routes/object_graph.py",
    ]
    present = [path for path in rel_paths if (_REPO_ROOT / path).exists()]
    assert not present, f"old object/backlink routes or components exist: {present}"

    edge_route = (_WEB_ROOT / "app" / "api" / "resource-graph" / "edges" / "route.ts").read_text(
        encoding="utf-8"
    )
    assert "export async function GET" not in edge_route


def test_reader_sidecar_alignment_owned_by_shared_surface():
    roots = [
        _WEB_ROOT
        / "components"
        / "reader"
        / "document-map"
        / "ReaderDocumentMapHighlightsLens.tsx",
        _WEB_ROOT / "components" / "reader" / "document-map" / "ReaderDocumentMapCitationsLens.tsx",
        _WEB_ROOT
        / "components"
        / "reader"
        / "document-map"
        / "ReaderDocumentMapConnectionsLens.tsx",
    ]
    hits = _filtered(r"\b(setAlignedRows|rowHeights|overflowCount)\b", *roots)
    assert not hits, f"reader surfaces own duplicate sidecar alignment state:\n{_fmt(hits)}"

    shared = (_WEB_ROOT / "components" / "reader" / "AnchoredSidecarSurface.tsx").read_text(
        encoding="utf-8"
    )
    assert "setAlignedRows" in shared


# =============================================================================
# Reader Document Map cutover — one aggregate reader instrument
# =============================================================================


def test_reader_document_map_old_product_files_absent():
    rel_paths = [
        "apps/web/src/app/api/media/[id]/apparatus/route.ts",
        "apps/web/src/app/api/media/[id]/reader-connections/route.ts",
        "apps/web/src/components/reader/ReaderApparatusSurface.tsx",
        "apps/web/src/components/reader/ReaderApparatusSurface.module.css",
        "apps/web/src/components/reader/ReaderHighlightsSurface.tsx",
        "apps/web/src/components/reader/ReaderHighlightsSurface.module.css",
        "apps/web/src/components/reader/ReaderConnectionsSurface.tsx",
        "apps/web/src/components/reader/ReaderConnectionsSurface.module.css",
        "apps/web/src/components/reader/ReaderOverviewRuler.tsx",
        "apps/web/src/components/reader/ReaderOverviewRuler.module.css",
        "apps/web/src/components/reader/overviewPositions.ts",
        "apps/web/src/components/reader/ReaderHighlightsSurface.tsx",
        "apps/web/src/components/reader/ReaderHighlightsSurface.module.css",
        "apps/web/src/components/reader/ReaderApparatusSurface.tsx",
        "apps/web/src/components/reader/ReaderApparatusSurface.module.css",
        "apps/web/src/components/reader/ReaderConnectionsSurface.tsx",
        "apps/web/src/components/reader/ReaderConnectionsSurface.module.css",
        "apps/web/src/lib/media/readerConnections.ts",
        "python/tests/test_reader_connections_routes.py",
    ]
    present = [path for path in rel_paths if (_REPO_ROOT / path).exists()]
    assert not present, f"old reader Document Map product files exist: {present}"


def test_reader_document_map_legacy_affordances_absent():
    e2e_root = _REPO_ROOT / "e2e"
    hits = _grep(
        r"ReaderOverviewRuler|reader-overview-ruler|reader-overview-tick|overviewPositions|OVERVIEW_RULER_WIDTH_PX|Open highlights pane|Show highlights|Show contents",
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        e2e_root,
    )
    assert not hits, f"legacy reader overview/highlight affordance remains:\n{_fmt(hits)}"


def test_reader_document_map_legacy_product_routes_absent():
    hits = _filtered(
        r'@router\.(get|post|put|delete)\("/media/\{media_id\}/(apparatus|reader-connections)"|proxyToFastAPI\(req, `/media/\$\{id\}/(apparatus|reader-connections)',
        _PY_ROOT,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"legacy reader product route remains:\n{_fmt(hits)}"


# =============================================================================
# Synapse: one origin='synapse' edge writer (synapse spec AC9)
# =============================================================================


def test_synapse_origin_edges_constructed_only_in_synapse_service():
    # The resonance engine is the sole writer of origin='synapse' edges; any
    # other production construction site would bypass the replace-set +
    # suppression semantics. (python/tests lives outside the scanned roots;
    # the frontend only compares the origin, it never constructs it.)
    hits = _excluding(
        _grep(r'origin="synapse"', _PY_ROOT, _SCRIPTS_ROOT),
        "services/synapse.py",
        "services/resource_graph/policy.py",
    )
    assert not hits, f'origin="synapse" written outside services/synapse.py:\n{_fmt(hits)}'
