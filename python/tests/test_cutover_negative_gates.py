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
        # apps/web/src/lib/objectRefs.ts (the fourth original registry) is
        # deleted outright by the universal-link-authoring cutover (its
        # ObjectRef search/resolve surface is gone; see
        # test_object_ref_search_resolve_surface_absent below) — a deleted
        # file trivially carries no tag literal, so it is dropped from this
        # list rather than read from a path that no longer exists.
        "python/nexus/services/resource_graph/refs.py",
        "apps/web/src/lib/resourceGraph/resourceRef.ts",
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
    # current_revision_id / revision_id / artifact_revisions
    # are the Rev-3 model and must NOT be matched by any absence gate above. Prove
    # they're live (present in production) so the gates can never be "tightened"
    # into banning them by accident.
    for symbol in (
        "artifact_revisions",
        "current_revision_id",
        "revision_id",
    ):
        hits = _grep(re.escape(symbol), _PY_ROOT)
        assert hits, f"expected allowed Rev-3 symbol {symbol} to be present in production"


def test_li_generated_citations_never_source_from_artifact_head():
    pattern = (
        r"source\s*=\s*ResourceRef\(\s*scheme\s*=\s*['\"]artifact['\"]|"
        r"source_scheme\s*=\s*['\"]artifact['\"].*ordinal\s*="
    )
    hits = _filtered(pattern, _PY_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        "Library Intelligence generated citations must source from "
        "artifact_revision, never the mutable artifact head:\n"
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
        # Scalar property/parameter annotations (`citation: ReaderCitationData;`)
        # are also consumers — they end with a semicolon after the bare type name.
        and not re.search(r": ReaderCitationData\s*;", hit.text)
    ]
    # Exactly one: the toReaderCitationData return type in resourceGraph/citations.ts.
    assert len(constructors) == 1, (
        f"expected one ReaderCitationData constructor:\n{_fmt(constructors)}"
    )
    assert constructors[0].path.endswith("resourceGraph/citations.ts")
    assert "toReaderCitationData" in constructors[0].text


# =============================================================================
# Universal Dossier controller is stream-driven (apps/web)
# =============================================================================


def test_dossier_surface_does_not_poll():
    dossier_files = [
        _WEB_ROOT / "components" / "dossier" / "DossierSurface.tsx",
        _WEB_ROOT / "lib" / "dossiers" / "useResourceInspector.ts",
        _WEB_ROOT / "lib" / "dossiers" / "generationAdapter.ts",
    ]
    for f in dossier_files:
        assert f.exists(), f"expected universal Dossier owner {f}"
    pattern = r"refreshVersion|setInterval|setTimeout|refetchInterval|pollInterval"
    hits = _grep(pattern, *dossier_files)
    assert not hits, f"Dossier surface uses a polling primitive:\n{_fmt(hits)}"


# =============================================================================
# Universal Dossier owner gate
# =============================================================================


def test_dossier_runtime_has_one_generic_route_and_engine_owner():
    owners = (
        _PY_ROOT / "api" / "routes" / "dossiers.py",
        _PY_ROOT / "services" / "artifacts" / "engine.py",
    )
    for path in owners:
        assert path.exists(), f"expected universal Dossier owner {path}"
    legacy_facades = (
        _PY_ROOT / "services" / "artifacts" / "dossier.py",
        _PY_ROOT / "services" / "artifacts" / "distillate.py",
    )
    assert not [path for path in legacy_facades if path.exists()]
    route_source = owners[0].read_text()
    assert "if manifest.kind" not in route_source
    assert "media_intelligence" not in route_source
    assert "_media_abstract" not in route_source


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
# Platform key loader: no raw settings.<provider>_api_key reads outside
# services/llm_credentials.py (LLM-provider-runtime cutover §9)
# =============================================================================


def test_no_raw_provider_key_reads_outside_llm_credentials():
    # BYOK / api_key_resolver "key spine" is gone. services/llm_credentials.py is the
    # SOLE platform-key loader (it reads the five provider keys off Settings and hands
    # back a runtime ProviderCredential for generation/embedding/transcription);
    # config.py owns the Settings fields and their staging/prod startup validation. No
    # other Nexus module may read a raw provider key. (cloudflare_ai_api_token is gone
    # with Cloudflare LLM; moonshot is added as a primary direct provider.)
    pattern = r"settings\.(openai|anthropic|gemini|moonshot|openrouter)_api_key"
    hits = _excluding(
        _grep(pattern, _PY_ROOT),
        "services/llm_credentials.py",
        "config.py",
    )
    assert not hits, f"raw provider-key read outside services/llm_credentials.py:\n{_fmt(hits)}"


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

    # LLM-provider-runtime cutover §14: the root Makefile owns the required release
    # build gate `certify-llm-providers`. It runs the UNFILTERED paid matrix (by
    # delegating to the shared-matrix target) and REFUSES to run — fail closed — when
    # any required direct/OpenRouter credential or the Fable retention assertion is
    # missing, specifically rejecting a missing OPENROUTER_API_KEY.
    assert "certify-llm-providers:" in makefile
    assert "REFUSING to run" in makefile
    assert "MOONSHOT_API_KEY" in makefile
    assert "OPENROUTER_API_KEY" in makefile
    assert "NEXUS_FABLE_RETENTION_ACCEPTED_AT" in makefile

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

    # §14: the protected release-promotion job runs the unfiltered certification and
    # fails closed on missing live secrets, while ordinary deterministic PR CI never
    # claims paid-live success. It is environment-gated (android-release.yml pattern),
    # restricted to promotion (push to main), sets the Moonshot key + Fable assertion
    # the certification needs, and invokes `make certify-llm-providers`.
    assert "certify-llm-providers:" in workflow
    assert "environment: llm-live-certification" in workflow
    assert "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" in workflow
    assert "secrets.MOONSHOT_API_KEY" in workflow
    assert "secrets.NEXUS_FABLE_RETENTION_ACCEPTED_AT" in workflow
    assert "run: make certify-llm-providers" in workflow

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


def test_generation_runtime_calls_stay_inside_llm_execution():
    # LLM-provider-runtime hard cutover §9/§14: services/llm_execution.py is the sole
    # Nexus generation boundary. Only its ProductionExecutionRuntime may call
    # provider_runtime.ProviderRuntime.generate/stream, and only its
    # execute_generation/execute_generation_stream may dispatch the ExecutionRuntime
    # seam (runtime.generate / runtime.stream). No other Nexus module may reach a
    # generation runtime; the old LedgeredLLM/llm_ledger.generate boundary is gone.
    #
    # The ExecutionRuntime Protocol and the real-media fixture DEFINE `async def
    # generate` / `def stream`; those definitions have no receiver dot and so never
    # match a `.generate(`/`.stream(` call. Non-generation ports (`.embed(`,
    # `.transcribe(`) are out of scope and legitimately live in their owners.
    hits = _excluding(
        _grep(
            r"\b(?:provider_runtime|runtime|llm_runtime|model_runtime|provider_router|llm_router)"
            r"\.(?:generate|stream)\(",
            _PY_ROOT,
        ),
        "services/llm_execution.py",
    )
    assert not hits, (
        f"generation-runtime generate/stream call outside services/llm_execution.py:\n{_fmt(hits)}"
    )


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

    # The retryable-conflict predicate is referenced only where the loop is defined
    # (db/retries.py) and where the predicate itself lives (db/errors.py).
    loop_hits = _excluding(
        _grep(r"is_retryable_transaction_conflict", _PY_ROOT),
        "db/retries.py",
        "db/errors.py",
    )
    assert not loop_hits, f"serialization-failure loop outside db/retries.py:\n{_fmt(loop_hits)}"


# =============================================================================
# Add Content intake: one canonical media-membership write surface
# =============================================================================


def test_media_library_entry_dml_has_one_owner():
    dml = re.compile(
        r"(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+library_entries\b|"
        r"\b(?:insert|update|delete)\(\s*LibraryEntry(?:\.__table__)?\b|"
        r"\b(?:db|session)\.(?:add|delete)\(\s*LibraryEntry\(",
        re.IGNORECASE,
    )
    hits: list[_Hit] = []
    for path in _iter_scan_files(_PY_ROOT):
        if path.as_posix().endswith("/services/library_entries.py"):
            continue
        source = path.read_text(encoding="utf-8", errors="ignore")
        lines = source.splitlines()
        for match in dml.finditer(source):
            line_no = source.count("\n", 0, match.start()) + 1
            hits.append(_Hit(path=path.as_posix(), line=line_no, text=lines[line_no - 1].strip()))
    assert not hits, f"library-entry DML escaped its canonical owner:\n{_fmt(hits)}"


def test_add_content_membership_contract_spans_backend_bff_client_and_normative_docs():
    legacy_pattern = (
        r"\b(?:AddMediaRequest|add_media_to_library|add_media_to_libraries_for_viewer|"
        r"remove_document_from_library|addMediaToLibrary|removeMediaFromLibrary|"
        r"MediaLibrariesResponse|library_ids_added)\b|"
        r"/(?:api/)?libraries/[^\s\"'`]+/media\b|"
        r"/(?:api/)?media/[^\s\"'`?]+\?library_id\b|"
        r"searchParams\.(?:set|append)\([\"']library_id[\"']"
    )

    production_hits = _grep(legacy_pattern, _PY_ROOT)
    web_hits = _filtered(
        legacy_pattern,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    normative_doc_hits = _excluding(
        _grep(
            legacy_pattern,
            _REPO_ROOT / "docs" / "architecture.md",
            _REPO_ROOT / "docs" / "modules",
            _REPO_ROOT / "docs" / "cutovers",
        ),
        # The canonical cutover specification names the deleted shapes only to
        # require and verify their removal.
        "add-content-intake-hard-cutover.md",
    )
    hits = [*production_hits, *web_hits, *normative_doc_hits]
    assert not hits, f"legacy media-membership contract residue survives:\n{_fmt(hits)}"

    old_bff = _WEB_ROOT / "app" / "api" / "libraries" / "[id]" / "media" / "route.ts"
    assert not old_bff.exists(), f"legacy inverse media-membership BFF survives: {old_bff}"

    backend_route = (_PY_ROOT / "api" / "routes" / "media.py").read_text(encoding="utf-8")
    backend_errors = (_PY_ROOT / "errors.py").read_text(encoding="utf-8")
    bff_route = (
        _WEB_ROOT / "app" / "api" / "media" / "[id]" / "libraries" / "[libraryId]" / "route.ts"
    ).read_text(encoding="utf-8")
    client = (_WEB_ROOT / "lib" / "media" / "mediaLibraries.ts").read_text(encoding="utf-8")
    library_doc = (_REPO_ROOT / "docs" / "modules" / "library.md").read_text(encoding="utf-8")

    assert '@router.delete("/media/{media_id}/libraries/{library_id}"' in backend_route
    assert '@router.post("/media/{media_id}/libraries", status_code=204)' in backend_route
    assert "E_MEDIA_LAST_REFERENCE" in backend_errors
    assert "`409 E_MEDIA_LAST_REFERENCE`" in library_doc
    assert "ensureMediaAbsentFromLibrary" in client
    assert "`/api/media/${mediaId}/libraries/${libraryId}`" in client
    assert "`/media/${id}/libraries/${libraryId}`" in bff_route


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
# Every profile offers its own default reasoning option
# =============================================================================


def test_every_profile_offers_its_default_reasoning():
    # The MODEL_CATALOG / curated-model + literal "default" reasoning concept is GONE;
    # the cutover replaces it with the product profile registry. Importing PROFILES is
    # allowed (pure data, no DB). Every profile must offer its own
    # default_reasoning_option_id within its declared reasoning_options — the same
    # invariant llm_profiles.validate_profiles() enforces at startup, restated here as
    # an independently CI-assertable §4/§10 gate.
    from nexus.services.llm_profiles import PROFILES

    assert PROFILES, "llm_profiles.PROFILES is empty"
    missing = [
        profile.id
        for profile in PROFILES
        if profile.default_reasoning_option_id
        not in {option.id for option in profile.reasoning_options}
    ]
    assert not missing, (
        f"profiles whose default_reasoning_option_id is not among their own "
        f"reasoning_options: {missing}"
    )


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
    # estimator stays (char *budgets* are domain and orthogonal). (message_retrievals
    # presence — the one chat-owned telemetry store that survives — is covered by the
    # parametrized must-REMAIN gate above; conversation_references/oracle_reading_passages/
    # object_links were folded into resource_edges by the provenance-graph cutover and are
    # now BANNED by the §18.3 dropped-symbol gates below.)
    #
    # ERROR_CODE_TO_MESSAGE (the old broad "request rejected by the model provider" prose
    # map) was DELETED by the LLM-provider-runtime cutover (§9 "Delete E_LLM_BAD_REQUEST
    # and every broad ... mapping"). Its surviving replacement surface — a structured,
    # run-owned projection — must remain: the closed ExpectedChatFailure tagged union in
    # schemas/llm.py and its single chat_failure_projection owner in
    # services/chat_failure.py (§10 failure/rerun).
    for symbol, where in (
        ("tail_cursor_stream", _PY_ROOT),
        ("tail_snapshot_stream", _PY_ROOT),
        ("ExpectedChatFailure", _PY_ROOT),
        ("chat_failure_projection", _PY_ROOT),
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
# connection — have two typed transport owners: the general generation-run opener
# and the one universal Dossier generation adapter. Resource panes never open
# streams directly.
_TRANSPORT_PRIMITIVE_OWNERS = (
    "lib/api/streamToken.ts",
    "lib/api/sse-client.ts",
    "lib/api/useGenerationRun.ts",
    "lib/dossiers/generationAdapter.ts",
)


def test_sse_transport_primitives_have_typed_owners_not_per_surface():
    # Divergence 1: transport primitives stay in their definition modules and
    # typed adapters, never in a resource-specific pane.
    hits = _excluding(
        [
            hit
            for hit in _grep(r"\bfetchStreamToken\b|\bsseClientDirect\b", _WEB_ROOT)
            if ".test." not in hit.path
        ],
        *_TRANSPORT_PRIMITIVE_OWNERS,
    )
    assert not hits, f"SSE transport primitive used outside a typed adapter:\n{_fmt(hits)}"

    for relative in ("lib/api/useGenerationRun.ts", "lib/dossiers/generationAdapter.ts"):
        opener_src = (_WEB_ROOT / relative).read_text()
        assert "fetchStreamToken" in opener_src, f"{relative} no longer mints the token"
        assert "sseClientDirect" in opener_src, f"{relative} no longer opens the stream"


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
        "services/resource_graph/citations.py",
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
    # The generic edges BFF route this test's last clause used to read
    # (`apps/web/src/app/api/resource-graph/edges/route.ts`) is itself deleted
    # by the universal-link-authoring cutover (spec, Mutation APIs > Stance:
    # "POST/DELETE /resource-graph/edges ... are deleted") — its narrower
    # "no GET verb" concern is subsumed by the file's outright absence, which
    # test_universal_link_authoring_deleted_files_absent below asserts.
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


def test_reader_sidecar_alignment_surface_absent_after_evidence_cutover():
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

    retired = _WEB_ROOT / "components" / "reader" / "AnchoredSidecarSurface.tsx"
    assert not retired.exists()


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
        "apps/web/src/lib/reader/apparatus.ts",
        "apps/web/src/lib/reader/apparatus.test.ts",
        "apps/web/src/lib/reader/apparatus.fixture.test.ts",
        "apps/web/src/lib/reader/__fixtures__/reader-apparatus",
        "python/scripts/generate_reader_apparatus_frontend_payloads.py",
        "python/tests/reader_apparatus_frontend_payloads.py",
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
# Web article inline embeds — backend-owned rows, no DOM rediscovery fallback
# =============================================================================


def test_inline_embed_frontend_does_not_rediscover_raw_provider_dom():
    hits = _filtered(
        r"twitter-tweet|querySelector(All)?\([^;\n]*(iframe|blockquote)",
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"frontend raw embed DOM discovery remains:\n{_fmt(hits)}"


def test_inline_embed_cutover_has_no_oembed_fallback_path():
    hits = _filtered(
        r"\boEmbed\b|oembed|publish\.twitter|platform\.twitter\.com/widgets",
        _PY_ROOT,
        _WEB_ROOT,
        _SCRIPTS_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"inline embed fallback/provider widget path remains:\n{_fmt(hits)}"


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


# =============================================================================
# Reader sidecar consolidation: old surface IDs must be ABSENT from the model
# (reader-sidecar-consolidation-hard-cutover.md §13)
# =============================================================================

_PANE_SECONDARY_MODEL = _WEB_ROOT / "lib" / "panes" / "paneSecondaryModel.ts"


def test_no_reader_resource_chat_surface():
    hits = _filtered(r"reader-resource-chat", _PANE_SECONDARY_MODEL)
    assert not hits, f'"reader-resource-chat" survives in paneSecondaryModel.ts:\n{_fmt(hits)}'


def test_no_reader_highlights_surface():
    hits = _filtered(r"reader-highlights", _PANE_SECONDARY_MODEL)
    assert not hits, f'"reader-highlights" survives in paneSecondaryModel.ts:\n{_fmt(hits)}'


def test_no_reader_embeds_surface():
    hits = _filtered(r"reader-embeds", _PANE_SECONDARY_MODEL)
    assert not hits, f'"reader-embeds" survives in paneSecondaryModel.ts:\n{_fmt(hits)}'


def test_no_reader_apparatus_surface():
    hits = _filtered(r"reader-apparatus", _PANE_SECONDARY_MODEL)
    assert not hits, f'"reader-apparatus" survives in paneSecondaryModel.ts:\n{_fmt(hits)}'


def test_no_reader_connections_surface():
    hits = _filtered(r"reader-connections", _PANE_SECONDARY_MODEL)
    assert not hits, f'"reader-connections" survives in paneSecondaryModel.ts:\n{_fmt(hits)}'


# =============================================================================
# Attention ledger cutover: read-state derivation moved OUT of attention into
# the consumption projection (lectern-player-lifecycle-hard-cutover.md §3),
# then services/attention.py and reading_sessions were dissolved outright
# (default-library-virtualization-and-transient-state-pruning-hard-cutover.md
# §1/§4.4/§6) — reader engagement (recency + max whole-document progression)
# now lives in the consumption package's own reader_engagement_states store.
# The old enrich functions remain gone.
# =============================================================================


def test_enrich_media_read_state_absent_from_production():
    # The collection read-state owner is now the consumption projection.
    hits = _grep(r"enrich_media_read_state", _PY_ROOT, _WEB_ROOT)
    assert not hits, f"enrich_media_read_state survives in production:\n{_fmt(hits)}"


def test_doc_and_audio_read_state_helpers_absent_from_production():
    # The per-medium derivation helpers are replaced by the consumption projection.
    hits = _grep(r"_doc_read_state|_audio_read_state", _PY_ROOT, _WEB_ROOT)
    assert not hits, f"_doc_read_state/_audio_read_state survive in production:\n{_fmt(hits)}"


def test_attention_dissolved_consumption_owns_reader_engagement():
    # default-library-virtualization §1/§4.4/§6: services/attention.py and
    # reading_sessions are gone outright — not renamed, not kept as a legacy
    # fallback. The two gates this replaces each scanned a single file
    # (services/attention.py) that no longer exists in production, so a
    # single positive owner-boundary gate stands in their place: no production
    # code names the dissolved module/table, and the table that superseded
    # reading_sessions has exactly one DML owner. Scanning python/nexus +
    # apps/web/src means the drop migrations (repo-root migrations/) and
    # python/tests/ (including test_migrations.py's historical, revision-
    # pinned classes) sit outside the scanned roots and may go on naming the
    # dissolved module/table as history without tripping this gate.
    dead_surface = _grep(
        r"\bimport attention\b|\bservices\.attention\b|\breading_sessions\b",
        _PY_ROOT,
        _WEB_ROOT,
    )
    assert not dead_surface, (
        f"dissolved attention.py/reading_sessions surface survives in "
        f"production:\n{_fmt(dead_surface)}"
    )

    owner_hits = _excluding(
        _grep(_CONSUMPTION_TABLE_WRITE + r"reader_engagement_states\b", _PY_ROOT),
        "services/consumption/_reader_engagement_store.py",
    )
    assert not owner_hits, (
        f"reader_engagement_states written outside its owner:\n{_fmt(owner_hits)}"
    )


# =============================================================================
# Grand atlas hard cutover: media_atlas_positions has exactly one writer
# (services/atlas_projection.py); no numpy in the projection service
# (grand-atlas-hard-cutover.md §13 G1/G2).
# =============================================================================

_ATLAS_PROJECTION_SERVICE = _PY_ROOT / "services" / "atlas_projection.py"


def test_media_atlas_positions_has_sole_writer():
    # G2: only atlas_projection.py may write media_atlas_positions. The route
    # only SELECTs it and models.py only declares it, so a write-verb scan flags
    # any second writer.
    hits = _grep(
        r"(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+media_atlas_positions",
        _PY_ROOT,
        _WEB_ROOT,
    )
    hits = [hit for hit in hits if "atlas_projection.py" not in hit.path]
    assert not hits, f"non-sole writer of media_atlas_positions:\n{_fmt(hits)}"


def test_atlas_projection_service_has_no_numpy():
    # G1: the projection is pure Python (no numpy/scipy/umap dependency).
    hits = _grep(
        r"import\s+numpy|from\s+numpy|import\s+scipy|import\s+umap", _ATLAS_PROJECTION_SERVICE
    )
    assert not hits, f"numpy/scipy/umap imported in atlas projection:\n{_fmt(hits)}"


def test_oracle_atlas_route_id_absent_from_pane_files():
    # G3: `oracleAtlas` was never a registered pane route (the grand atlas is its
    # own `/atlas` pane; `/oracle/atlas` only survives as an App Router redirect).
    # A future spec (e.g. oracle-shell-dissolution) must never re-add it, so the
    # three pane registration files must carry no `"oracleAtlas"` literal.
    pane_files = (
        _WEB_ROOT / "lib" / "panes" / "paneRouteModel.ts",
        _WEB_ROOT / "lib" / "panes" / "paneRenderRegistry.tsx",
        _WEB_ROOT / "lib" / "panes" / "paneRouteTable.ts",
    )
    hits = _grep(r'"oracleAtlas"', *pane_files)
    assert not hits, f"oracleAtlas route id survives in a pane file:\n{_fmt(hits)}"


# =============================================================================
# Second apparatus hard cutover: span-grain synapse + user Cite/stance
# (second-apparatus-hard-cutover.md §13, clauses 1, 3, 5)
# =============================================================================

_SECOND_APPARATUS_MIGRATION = (
    _REPO_ROOT / "migrations" / "alembic" / "versions" / "0173_synapse_span_grain_targets.py"
)
_API_ROOT = _PY_ROOT / "api"


def test_evidence_span_synapse_edge_target_constructed_only_in_synapse():
    # Clause 1: only services/synapse.py mints a *synapse* edge inline-targeting an
    # evidence_span. Dossier bindings may propose evidence-span citation
    # candidates; those are citation-origin targets, not Synapse writers.
    hits = [
        hit
        for hit in _grep(r'target=ResourceRef\(scheme="evidence_span"', _PY_ROOT, _SCRIPTS_ROOT)
        if not hit.path.endswith("services/synapse.py")
        and "/services/artifacts/bindings/" not in hit.path
    ]
    assert not hits, f"evidence_span synapse edge target built outside synapse.py:\n{_fmt(hits)}"


def test_second_apparatus_migration_creates_no_table():
    # Clause 3: the widen migration adds no table (zero new tables, §5/G-5).
    hits = _filtered(r"create_table|CREATE TABLE", _SECOND_APPARATUS_MIGRATION)
    assert not hits, f"0173 migration creates a table:\n{_fmt(hits)}"


def test_no_margin_backend_endpoint():
    # Clause 5: the margin reuses the reader-connections read model; no forked
    # /media/{id}/margin route or margin_projection builder exists (N-5/D-6).
    hits = _grep(r"/media/\{[a-z_]+\}/margin|def .*margin_projection", _API_ROOT)
    assert not hits, f"a dedicated margin backend endpoint exists:\n{_fmt(hits)}"


# =============================================================================
# Lectern hard cutover: one consumption queue across kinds
# (lectern-hard-cutover.md §13, gates G-1/G-2/G-3/G-7)
# =============================================================================


def test_lectern_old_table_name_absent():
    # G-1: the old table name is dead in production code; only the rename
    # migration (outside the grep roots) may still name it.
    hits = _grep(r"\bplayback_queue_items\b", _PY_ROOT)
    assert not hits, f"old playback_queue_items table still referenced:\n{_fmt(hits)}"


def test_lectern_old_service_and_schema_absent():
    # G-2/G-3: the old service + schema modules are deleted; no live import path.
    hits = _grep(
        r"services[./]playback_queue|schemas[./]playback|"
        r"from nexus\.services\.playback_queue|from nexus\.schemas\.playback|"
        r"\bPlaybackQueueItem\b",
        _PY_ROOT,
    )
    assert not hits, f"old playback_queue service/schema still referenced:\n{_fmt(hits)}"


def test_lectern_old_modules_deleted():
    for rel_path in (
        "python/nexus/services/playback_queue.py",
        "python/nexus/schemas/playback.py",
        "python/nexus/api/routes/playback.py",
    ):
        assert not (_REPO_ROOT / rel_path).exists(), f"{rel_path} must be deleted"


def test_lectern_queue_table_sole_writer():
    # Superseded by lectern-player-lifecycle-hard-cutover.md §8 AC-15: the Lectern
    # membership/order table's sole writer is services/consumption/_lectern_store.py
    # (db/models.py is the ORM schema owner). media_deletion.py NO LONGER writes this
    # table — the media-teardown unit composes the consumption owner's all-users delete
    # — so its TEMP allowlist entry is dropped and the gate is now tight.
    #
    # _projection.py is the read-model owner: it holds the two read-only Lectern
    # membership queries (lectern_membership_rows_sql / lectern_item_count, both pure
    # SELECTs). Reading the relation from the projection layer is the intended shape;
    # only WRITES are restricted to _lectern_store.py, so the read-owner is allowlisted
    # alongside the ORM schema owner.
    hits = _excluding(
        _grep(r"\bconsumption_queue_items\b", _PY_ROOT),
        "services/consumption/_lectern_store.py",
        "services/consumption/_projection.py",
        "db/models.py",
    )
    assert not hits, f"consumption_queue_items written outside its owner:\n{_fmt(hits)}"


# =============================================================================
# Lectern + global player lifecycle hard cutover
# (lectern-player-lifecycle-hard-cutover.md §7 delete map, §8 AC-15)
# =============================================================================

_CONSUMPTION_TABLE_WRITE = r"(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"


def test_consumption_overrides_sole_writer():
    # §8 AC-15: explicit-state DML lives only in the consumption state store.
    # media_deletion.py does NOT write consumption_overrides today (verified).
    hits = _excluding(
        _grep(_CONSUMPTION_TABLE_WRITE + r"consumption_overrides", _PY_ROOT),
        "services/consumption/_state_store.py",
    )
    assert not hits, f"consumption_overrides written outside its owner:\n{_fmt(hits)}"


def test_podcast_listening_states_sole_writer():
    # §8 AC-15: listening position/duration/speed DML lives only in the listening
    # store. media_deletion.py NO LONGER deletes this table — the media-teardown unit
    # composes the consumption owner — so its TEMP allowlist entry is dropped.
    hits = _excluding(
        _grep(_CONSUMPTION_TABLE_WRITE + r"podcast_listening_states", _PY_ROOT),
        "services/consumption/_listening_store.py",
    )
    assert not hits, f"podcast_listening_states written outside its owner:\n{_fmt(hits)}"


# =============================================================================
# Media teardown (lectern-player-lifecycle-hard-cutover.md §3.1) gates
# =============================================================================


def test_media_teardown_intents_sole_writers():
    # §3.1: media_teardown_intents DML (INSERT/UPDATE/DELETE) lives ONLY in the claim
    # owner (services/media_deletion.py) and the teardown job (tasks/media_teardown.py).
    # Reads (the consumption projection, the reference barrier) are unrestricted.
    dml = r"(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+media_teardown_intents\b"
    hits = _excluding(
        _grep(dml, _PY_ROOT),
        "services/media_deletion.py",
        "tasks/media_teardown.py",
    )
    assert not hits, f"media_teardown_intents written outside its owners:\n{_fmt(hits)}"


def test_storage_object_delete_callers_enumerated():
    # §3.1: media-teardown storage deletion is owned by the three durable task modules.
    # Every other .delete_object( callsite is an enumerated legacy site: pre-existing
    # error/compensation/GC cleanup that is NOT media teardown (upload error cleanup,
    # EPUB asset compensation, library teardown, remote-file missing-media teardown,
    # extraction-artifact requeue GC), plus the storage client's own impl. New ad-hoc
    # teardown deletes outside the task modules fail here.
    allowed = (
        # The three durable teardown/sweep task modules (spec §3.1).
        "tasks/media_teardown.py",
        "tasks/storage_object_cleanup.py",
        "tasks/storage_orphan_sweep.py",
        # Enumerated legacy (non-teardown) storage-delete sites.
        "services/upload.py",
        "services/epub_ingest.py",
        "services/library_governance.py",
        "services/media_source_ingest.py",
        "services/media_deletion.py",
        "storage/client.py",
    )
    hits = _excluding(_grep(r"\.delete_object\(", _PY_ROOT), *allowed)
    assert not hits, f".delete_object called outside enumerated owners:\n{_fmt(hits)}"


def test_reconcile_stale_ingest_no_inline_storage_delete():
    # §3.1 (deliverable 6): the stale-ingest reconciler dropped its post-commit
    # best-effort object deletes in favor of the durable media_teardown job.
    reconcile = (_PY_ROOT / "tasks" / "reconcile_stale_ingest_media.py").read_text(encoding="utf-8")
    assert "delete_object" not in reconcile, (
        "reconcile_stale_ingest_media.py must not delete storage objects inline"
    )


def test_lectern_player_deleted_modules_absent():
    # §7 delete map: the pre-cutover queue/listening services, queue schema, and the
    # queue + consumption-override routes are gone (owners extracted first).
    for rel_path in (
        "python/nexus/services/consumption_queue.py",
        "python/nexus/services/listening_state.py",
        "python/nexus/schemas/queue.py",
        "python/nexus/api/routes/queue.py",
        "python/nexus/api/routes/consumption.py",
    ):
        assert not (_REPO_ROOT / rel_path).exists(), f"{rel_path} must be deleted"


def test_lectern_player_deleted_imports_absent():
    # No live import path to the deleted queue/listening service or queue schema.
    hits = _grep(
        r"\bnexus\.services\.consumption_queue\b"
        r"|from nexus\.services import[^\n]*\bconsumption_queue\b"
        r"|\bnexus\.services\.listening_state\b"
        r"|from nexus\.services import[^\n]*\blistening_state\b"
        r"|\bnexus\.schemas\.queue\b"
        r"|from nexus\.schemas\.queue\b",
        _PY_ROOT,
    )
    assert not hits, f"import of a deleted queue/listening module survives:\n{_fmt(hits)}"


def test_reading_sessions_absent_from_production():
    # default-library-virtualization §1: reading_sessions is one of the 8
    # tables the cutover drops. Its physical DROP TABLE waits for 0183's S6
    # completion (the migration stays create+backfill-only through S4/S5, per
    # the locked S4 decision, since the backfill itself reads reading_sessions
    # for a null-safe GREATEST(...) recency union), but its former sole writer
    # (services/attention.py) is deleted outright in S4, so no production code
    # may reference the table any more.
    hits = _grep(r"\breading_sessions\b", _PY_ROOT, _WEB_ROOT)
    assert not hits, f"reading_sessions survives in production:\n{_fmt(hits)}"


def test_consumption_projection_reads_confined_to_owners():
    # §3/§8 AC-15, updated by default-library-virtualization §1/§4.4/§6: "no
    # direct consumption projection read remains outside _projection or its
    # per-table store owner" (attention's aggregate read is gone along with
    # attention.py/reading_sessions; reader_engagement_states, its successor,
    # is read only through _reader_engagement_store.py). A fully general
    # read-gate is impractical: services/media.py is a spec-named projection
    # adopter (§7) that legitimately joins podcast_listening_states directly
    # to hydrate MediaOut.listening_state (raw position/duration/speed
    # passthrough, not the derived Unread/InProgress/Finished projection state),
    # so it is allowlisted by name rather than excluded generically. Any other
    # file selecting these three tables directly — a route, a new adopter, a
    # reintroduced per-feature read — fails here instead of forking the read
    # model. db/models.py never matches (it declares __tablename__, not
    # FROM/JOIN literals), so it needs no explicit exclusion.
    pattern = (
        r"\b(?:FROM|JOIN)\s+"
        r"(?:consumption_overrides|podcast_listening_states|reader_engagement_states)\b"
    )
    hits = _excluding(
        _grep(pattern, _PY_ROOT),
        "services/consumption/_state_store.py",
        "services/consumption/_listening_store.py",
        "services/consumption/_projection.py",
        "services/consumption/_reader_engagement_store.py",
        "services/media.py",
    )
    assert not hits, f"consumption table read outside its owner:\n{_fmt(hits)}"


def test_lifecycle_composition_callsites_enumerated():
    # §3/§8 AC-15: ensure_missing_items_in_txn (the auto-subscription watermark
    # step) and delete_media_consumption_state_in_txn (media teardown) are narrow
    # transaction-body exceptions to ordinary command ownership (spec §3). Each has
    # exactly one composition callsite beyond its definition in
    # services/consumption/service.py.
    ensure_hits = _excluding(
        _grep(r"\bensure_missing_items_in_txn\(", _PY_ROOT),
        "services/consumption/service.py",
        "services/podcasts/poll.py",
    )
    assert not ensure_hits, (
        f"ensure_missing_items_in_txn called outside its enumerated composition "
        f"callsite:\n{_fmt(ensure_hits)}"
    )

    delete_hits = _excluding(
        _grep(r"\bdelete_media_consumption_state_in_txn\(", _PY_ROOT),
        "services/consumption/service.py",
        "services/media_deletion.py",
    )
    assert not delete_hits, (
        f"delete_media_consumption_state_in_txn called outside its enumerated "
        f"composition callsite:\n{_fmt(delete_hits)}"
    )


def test_media_deletion_removes_four_child_families_before_parent():
    # §3/§8 AC-15, folded further by default-library-virtualization §1/§4.4/§6:
    # the four in-scope child families — Lectern, explicit override, listening
    # state, and reader engagement (the reading_sessions/attention.py
    # successor) — now live entirely inside the one consumption-owner call;
    # media_deletion.py no longer has a second, attention-owned call site.
    # Assert the single delete_media_consumption_state_in_txn call still
    # precedes the parent media DELETE, inside
    # delete_document_media_if_unreferenced.
    src = (_PY_ROOT / "services" / "media_deletion.py").read_text(encoding="utf-8")
    start = src.index("def delete_document_media_if_unreferenced(")
    end = src.index("\ndef ", start + 1)
    body = src[start:end]

    consumption_idx = body.index("consumption_service.delete_media_consumption_state_in_txn(")
    parent_delete_idx = body.index('text("DELETE FROM media WHERE id = :media_id")')

    assert consumption_idx < parent_delete_idx, (
        "consumption child-state deletion (all four families) must precede the parent media DELETE"
    )


def test_lectern_player_deleted_frontend_symbols_absent():
    # §7 delete map: the old FIFO/queue-panel frontend surface is gone —
    # consumptionQueueClient, usePodcastTrackSeeding, GlobalPlayerConsumptionPanel,
    # its update event, and the override POST helper have no live caller.
    pattern = (
        r"\bconsumptionQueueClient\b|\busePodcastTrackSeeding\b|"
        r"\bGlobalPlayerConsumptionPanel\b|\bCONSUMPTION_QUEUE_UPDATED_EVENT\b|"
        r"\bpostConsumptionOverride\b"
    )
    hits = _filtered(pattern, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"deleted Lectern/player frontend symbol survives:\n{_fmt(hits)}"


# ---------------------------------------------------------------------------
# Amanuensis: assistant write tools under origin discipline
# (amanuensis-hard-cutover.md §13, gates G1-G5)
# ---------------------------------------------------------------------------


def test_amanuensis_assistant_origin_written_only_in_writes_owner():
    # G1: exactly one module constructs origin='assistant' writes. The policy /
    # schema / route-owner mention the literal in validation, not construction.
    hits = _grep(r"origin\s*=\s*[\"']assistant[\"']", _PY_ROOT)
    allowed = re.compile(
        r"services/agent_tools/writes\.py"
        r"|resource_graph/(policy|schemas)\.py"
    )
    stray = [hit for hit in hits if not allowed.search(hit.path)]
    assert not stray, f"assistant-origin write outside writes.py:\n{_fmt(stray)}"


def test_amanuensis_no_destructive_write_tool():
    # G2: no delete/destroy/remove-capable write ToolSpec (N-1, additive only).
    writes = _PY_ROOT / "services" / "agent_tools" / "writes.py"
    hits = _grep(
        r"[\"']name[\"']:\s*[\"'](delete|remove|destroy|clear|overwrite|unfile|move)_",
        writes,
    )
    assert not hits, f"destructive assistant write tool registered:\n{_fmt(hits)}"


def test_amanuensis_write_tools_have_no_standalone_route():
    # G3: the five write tools have no standalone HTTP route path; their only
    # caller is the chat tool loop (N-7). We scan @router path decorators for a
    # tool-named endpoint. (``create_highlight`` is intentionally scanned only as
    # a path segment — the bare word collides with the pre-existing user
    # fragment-highlight route handler; a tool route would be a *path*.)
    hits = _grep(
        r"@router\.\w+\([\"'][^\"']*(add_to_library|jot_note|mint_edge|queue_add|"
        r"/create_highlight)",
        _PY_ROOT / "api" / "routes",
    )
    assert not hits, f"standalone write-tool route present:\n{_fmt(hits)}"


def test_amanuensis_text_quote_has_ambiguity_path():
    # G4: text_quote never returns offsets for a non-unique match.
    quote = _PY_ROOT / "services" / "text_quote.py"
    hits = _grep(r"ambiguous|no_match", quote)
    assert hits, "text_quote must classify ambiguous/no_match rather than guess"


def test_amanuensis_does_not_widen_llm_calls_owner_kind():
    # G5: this cutover does not touch ck_llm_calls_owner_kind (dawn-write owns it).
    models = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    idx = models.find("ck_llm_calls_owner_kind")
    assert idx != -1
    # The owner_kind CHECK block must not enumerate an assistant-write owner.
    window = models[max(0, idx - 800) : idx + 800]
    assert "assistant_write" not in window, "llm_calls owner_kind widened by amanuensis"


# #############################################################################
# Lightweight author-deduplication hard cutover (§9 docs/deployment, §10 AC 35/36)
#
# Same grep idiom as above: each gate scans python/nexus + apps/web/src and
# asserts a dropped author/reconciliation symbol is ABSENT, or a must-REMAIN
# owner is PRESENT. Migrations (repo-root migrations/ — including the historical
# 0169 identity-event migration and the frozen 0179 rewrite that keeps its own
# local copies of repoint/handle logic) and python/tests/ (the test_migrations
# fixtures) live OUTSIDE the scanned roots, so none of that immutable history can
# appear in a hit; only apps/web/src *.test.{ts,tsx} files need excluding.
# #############################################################################

# The credit-DTO + author-aggregate surface. A dropped credit field
# (resolution_status / source_ref / confidence) or a legacy/random handle digest
# can only meaningfully regress here; scoping to these owners keeps the gate off
# the unrelated reader/apparatus/document_embeds columns of the same name (e.g.
# lib/reader/documentMap.ts, schemas/reader_apparatus.py, services/document_embeds.py).
_CONTRIBUTOR_SURFACE_ROOTS = (
    _PY_ROOT / "schemas" / "contributors.py",
    _PY_ROOT / "services" / "contributor_credits.py",
    _PY_ROOT / "services" / "contributors.py",
    _PY_ROOT / "services" / "_contributor_identity.py",
    _PY_ROOT / "services" / "_contributor_credit_writes.py",
    _PY_ROOT / "services" / "contributor_taxonomy.py",
    _PY_ROOT / "api" / "routes" / "contributors.py",
    _WEB_ROOT / "lib" / "contributors",
    _WEB_ROOT / "components" / "contributors",
)

# The private author aggregate: where handle digests are minted (SHA-256 +
# deterministic ladder, never uuid4/md5 — D-7) and the fresh-session +
# SERIALIZABLE-retry discipline lives with no explicit locks (spec §2.7/§3, D-22).
_AUTHOR_AGGREGATE_ROOTS = (
    _PY_ROOT / "services" / "contributors.py",
    _PY_ROOT / "services" / "_contributor_identity.py",
    _PY_ROOT / "services" / "_contributor_credit_writes.py",
    _PY_ROOT / "services" / "contributor_taxonomy.py",
)


_INLINE_CODE_SPAN = re.compile(r"`+[^`]*`+")


def _backticked(token: str, line: str) -> bool:
    # A prose doc-mention wraps the symbol in backticks (``token``); a live code
    # reference never does. Lets the schemas/contributors.py "removed vs. legacy
    # shape" docstrings and the taxonomy "never ``uuid4()``" note narrate the
    # dropped primitives without tripping the gate. The check is per-occurrence, not
    # per-line: a line mixing a live reference with a backticked mention is NOT
    # skipped (LOW-1) — we strip every inline-code span (single or doubled
    # backticks) and only skip when no bare occurrence of the token survives.
    if f"`{token}" not in line:
        return False
    return token not in _INLINE_CODE_SPAN.sub("", line)


def test_author_dedup_dropped_symbols_absent():
    # AC 35: the reconciliation vertical, identity events, merge/tombstone
    # columns, dead taxonomy helpers, merged-chain readers, the scaffold credit
    # writers, the upstream preview fabricator, the external-key FTS text column,
    # the legacy handle-for-name digest, the status/kind vocab, and the directory
    # route are all gone from live code.
    pattern = "|".join(
        (
            r"\bcontributor_reconciliation\b",
            r"\bContributorIdentityEvent\b",
            r"\bmerged_into_contributor_id\b",
            r"\bCONFIRMED_ALIAS_SOURCES\b",
            r"\bnormalize_contributor_name\b",
            r"\bresolve_canonical_contributor_ids\b",
            r"\bupstream_contributor_credit_previews_for_names\b",
            r"\breplace_\w*contributor_credits\w*\b",
            r"\bexternal_id_text\b",
            r"\bcontributor_handle_for_name\b",
            r"\bContributorStatus\b",
            r"\bContributorKind\b",
            r"contributors/directory",
        )
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"author-dedup dropped symbol present in live code:\n{_fmt(hits)}"


def test_cutover_scaffold_marker_absent():
    # The bridge symbols kept importable across S2->S5 carried a CUTOVER-SCAFFOLD
    # marker; S5 deletes them, so the marker itself must be gone (never ships).
    hits = _filtered(r"CUTOVER-SCAFFOLD", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"CUTOVER-SCAFFOLD bridge marker still in live code:\n{_fmt(hits)}"


def test_runtime_repoint_edges_absent():
    # The last runtime caller (identity merge/split) is deleted with the
    # reconciliation vertical; migration 0179 keeps only a frozen local rewrite
    # (outside the scan roots), so no live repoint_edges symbol may remain.
    hits = _filtered(r"\brepoint_edges\b", _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"runtime repoint_edges still present:\n{_fmt(hits)}"


def test_dropped_credit_fields_absent_from_contributor_surface():
    # D-33: the narrowed embedded credit DTO drops resolution_status / source_ref /
    # confidence. Scan only the contributor credit surface so the unrelated reader/
    # apparatus/document_embeds columns of the same name are untouched; allow the
    # schemas/contributors.py docstrings that narrate the removal (backticked).
    offenders: list[_Hit] = []
    for token in ("resolution_status", "source_ref", "confidence"):
        for hit in _grep(rf"\b{token}\b", *_CONTRIBUTOR_SURFACE_ROOTS):
            if _FRONTEND_TEST.search(hit.path) or _backticked(token, hit.text):
                continue
            offenders.append(hit)
    assert not offenders, f"dropped credit field on the contributor surface:\n{_fmt(offenders)}"


def test_author_aggregate_uses_no_random_weak_digest_or_lock():
    # AC 35 (random handle fallback) + spec §2.7/§3 (no locks). Handles are
    # SHA-256 + deterministic ladder — never uuid4()/md5(); a true collision is a
    # defect. SERIALIZABLE + bounded retry only — no explicit/advisory locks. The
    # ownership-guard suite AST-gates these too; this is the greppable restatement
    # (backticked prose like the "never ``uuid4()``" docstring is allowed).
    offenders: list[_Hit] = []
    for token in ("uuid4", "md5", "with_for_update", "pg_advisory"):
        for hit in _grep(rf"\b{token}\b", *_AUTHOR_AGGREGATE_ROOTS):
            if _backticked(token, hit.text):
                continue
            offenders.append(hit)
    assert not offenders, (
        f"random/weak/locking primitive in the author aggregate:\n{_fmt(offenders)}"
    )


def test_max_credits_per_managed_role_pinned_in_both_languages():
    # D-6: the 20-cap literal is mirrored in the Python taxonomy leaf and the TS
    # constants module (Python annotates it ``: Final``; both must read = 20).
    cap = re.compile(r"MAX_CREDITS_PER_MANAGED_ROLE\s*(?::\s*\w+\s*)?=\s*20\b")
    py = (_PY_ROOT / "services" / "contributor_taxonomy.py").read_text(encoding="utf-8")
    ts = (_WEB_ROOT / "lib" / "contributors" / "constants.ts").read_text(encoding="utf-8")
    assert cap.search(py), "contributor_taxonomy.py is missing MAX_CREDITS_PER_MANAGED_ROLE = 20"
    assert cap.search(ts), "constants.ts is missing MAX_CREDITS_PER_MANAGED_ROLE = 20"


def test_author_error_code_present_in_backend_and_feedback():
    # D-10: E_AUTHOR_ALREADY_LISTED is a real error code and has user copy in the
    # Feedback title map (must not be silently dropped by an over-eager sweep).
    errors = (_PY_ROOT / "errors.py").read_text(encoding="utf-8")
    feedback = (_WEB_ROOT / "components" / "feedback" / "Feedback.tsx").read_text(encoding="utf-8")
    assert "E_AUTHOR_ALREADY_LISTED" in errors, "errors.py dropped E_AUTHOR_ALREADY_LISTED"
    assert "E_AUTHOR_ALREADY_LISTED" in feedback, (
        "Feedback title map dropped E_AUTHOR_ALREADY_LISTED"
    )


def test_reserved_contributor_handle_segments_present_in_both_languages():
    # The reserved collection segments (directory / reconciliation-candidates) are
    # shadowed in both the Python taxonomy and the TS handle grammar.
    py = (_PY_ROOT / "services" / "contributor_taxonomy.py").read_text(encoding="utf-8")
    ts = (_WEB_ROOT / "lib" / "contributors" / "handle.ts").read_text(encoding="utf-8")
    assert "RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS" in py, "taxonomy dropped reserved-segment set"
    assert "RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS" in ts, "handle.ts dropped reserved-segment set"


# #############################################################################
# Default-library virtualization & transient-state pruning — AC16 extirpation
# gate (default-library-virtualization-and-transient-state-pruning-hard-
# cutover.md §16).
#
# This is ONE broad, POSITIVE gate — additive to, not a replacement for, the
# narrower default-library-virtualization gates declared earlier in this file
# (test_reading_sessions_absent_from_production,
# test_attention_dissolved_consumption_owns_reader_engagement,
# test_consumption_projection_reads_confined_to_owners,
# test_lifecycle_composition_callsites_enumerated,
# test_media_deletion_removes_four_child_families_before_parent). Those stay
# exactly as written; this gate scans a much wider surface for the FULL AC16
# symbol list in one pass.
#
# Scanned roots: python/nexus, apps/web (src + scripts — node_modules,
# bun.lock, and generated build caches are not source, so they are not
# enumerated as roots), production-adjacent scripts (python/scripts,
# repo-root scripts/) + the Makefile, non-historical Python tests
# (python/tests/, minus the two files excluded below), docs/architecture.md,
# and docs/modules/.
#
# Excluded, per AC16:
#   - Immutable migrations (repo-root migrations/) and docs/cutovers/** are
#     simply never added to the root list above, so — exactly like the
#     migrations/python-tests exclusion documented at the top of this file —
#     neither can ever appear in a hit; no runtime filter is needed for them.
#     (docs/cutovers/** legitimately keeps naming these symbols: e.g.
#     resource-provenance-graph-hard-cutover.md still describes
#     message_retrieval_candidate_ledgers as live chat telemetry, which was
#     true when that cutover landed and predates this cutover's 0183 drop —
#     it is superseded history, not a live reference.)
#   - test_migrations.py is excluded by name: it is pinned to historical
#     revisions and is EXPECTED to keep constructing/asserting these dropped
#     tables/columns forever (that is its entire job).
#   - This file's OWN declarations are excluded by name too — both the
#     token-list constants below and the narrower pre-existing gates listed
#     above (test_reading_sessions_absent_from_production etc.) legitimately
#     name these same dead symbols as grep patterns/comments in THIS file.
#   - Two individual, non-historical residual lines are allowlisted by EXACT
#     line text (not by whole file), so nothing else in either file gets a
#     free pass: test_libraries.py asserts (by SELECT COUNT(*) == 0) that the
#     closure-backfill job kind is never enqueued — a live absence proof, the
#     same spirit as this gate. test_permissions.py's docstrings explain,
#     historically, why the read invariant they test never depended on the
#     (now-dropped) provenance tables — narrative prose, not a construction.
# #############################################################################

_AC16_WEB_SCRIPTS_ROOT = _REPO_ROOT / "apps" / "web" / "scripts"
_AC16_MAKEFILE = _REPO_ROOT / "Makefile"
_AC16_ARCHITECTURE_DOC = _REPO_ROOT / "docs" / "architecture.md"
_AC16_MODULES_ROOT = _REPO_ROOT / "docs" / "modules"
_AC16_PY_TESTS_ROOT = _REPO_ROOT / "python" / "tests"

# default-library-virtualization §1 — the eight dropped tables.
_AC16_DROPPED_TABLES = (
    "library_entry_page_snapshot_items",
    "library_entry_page_snapshots",
    "reading_sessions",
    "message_retrieval_candidate_ledgers",
    "message_rerank_ledgers",
    "default_library_backfill_jobs",
    "default_library_closure_edges",
    "default_library_intrinsics",
)

# Deleted ORM/DTO model, enum, and TS type names.
_AC16_DROPPED_MODELS = (
    "DefaultLibraryIntrinsic",
    "DefaultLibraryClosureEdge",
    "DefaultLibraryBackfillJob",
    "DefaultLibraryBackfillJobStatus",
    "LibraryEntryPageSnapshot",
    "LibraryEntryPageSnapshotItem",
    "ReadingSession",
    "MessageRetrievalCandidateLedger",
    "MessageRerankLedger",
    "ReaderProgressWrite",
    "AttentionBlock",
)

# Deleted job kinds / route modules / service helpers.
_AC16_DROPPED_JOBS_ROUTES_HELPERS = (
    "backfill_default_library_closure_job",
    "internal_libraries",
    "add_library_entry_only",
    "record_attention",
    "session_aggregates",
    "reading_recency",
)

# Deleted DTO field names (candidate-selection / rerank telemetry).
_AC16_DROPPED_DTO_FIELDS = (
    "candidate_ledgers",
    "rerank_ledgers",
    "candidate_inclusion_mismatch",
)

# Attention-module path literals: no gate/allowlist anywhere may still name
# these deleted files, not even as an *excluded* entry in someone else's
# allowlist tuple.
_AC16_DEAD_ATTENTION_PATH_LITERALS = (
    "services/attention.py",
    "schemas/attention.py",
)

_AC16_PATTERN = "|".join(
    [
        rf"\b{re.escape(token)}\b"
        for token in (
            *_AC16_DROPPED_TABLES,
            *_AC16_DROPPED_MODELS,
            *_AC16_DROPPED_JOBS_ROUTES_HELPERS,
            *_AC16_DROPPED_DTO_FIELDS,
        )
    ]
    + [re.escape(token) for token in _AC16_DEAD_ATTENTION_PATH_LITERALS]
)

# Raw Default containment SQL is subsumed by the table-name absence above
# (AC16): a "FROM default_library_intrinsics"/"default_library_closure_edges"
# containment query cannot exist without naming one of those two tables, both
# already banned by _AC16_DROPPED_TABLES.

_AC16_ALLOWED_TEST_LINES = {
    "python/tests/test_libraries.py": {
        "\"WHERE kind = 'backfill_default_library_closure_job'\"",
    },
    "python/tests/test_permissions.py": {
        "- Provenance alone (the former default_library_intrinsics /",
        "default_library_closure_edges tables, dropped in migration 0183) never",
        "membership. (Provenance rows, e.g. the former default_library_intrinsics",
        "default_library_closure_edges table, never granted access by themselves --",
    },
}


def _ac16_allowed_residual_test_line(hit: _Hit) -> bool:
    for suffix, allowed_lines in _AC16_ALLOWED_TEST_LINES.items():
        if hit.path.endswith(suffix) and hit.text in allowed_lines:
            return True
    return False


def test_default_library_virtualization_ac16_extirpation_gate():
    ac16_roots = (
        _PY_ROOT,
        _WEB_ROOT,
        _AC16_WEB_SCRIPTS_ROOT,
        _SCRIPTS_ROOT,
        _REPO_SCRIPTS_ROOT,
        _AC16_MAKEFILE,
        _AC16_ARCHITECTURE_DOC,
        _AC16_MODULES_ROOT,
        _AC16_PY_TESTS_ROOT,
    )

    # Non-vacuity guard: every root must exist, and the combined file list
    # must be large — a typo'd/misconfigured root would otherwise silently
    # scan nothing (or near-nothing) and this gate would pass for the wrong
    # reason. (~2,600 files are expected across these roots at time of
    # writing; 1,000 is a generous floor that still catches a missing root.)
    for root in ac16_roots:
        assert root.exists(), f"AC16 scan root does not exist: {root}"
    scanned_files = [file for root in ac16_roots for file in _iter_scan_files(root)]
    assert len(scanned_files) > 1000, (
        f"AC16 scan touched only {len(scanned_files)} files across {len(ac16_roots)} "
        "roots — a root is probably misconfigured (non-vacuity guard)."
    )

    hits = _grep(_AC16_PATTERN, *ac16_roots)
    hits = _excluding(hits, "test_migrations.py", "test_cutover_negative_gates.py")
    hits = [hit for hit in hits if not _ac16_allowed_residual_test_line(hit)]
    assert not hits, f"AC16-dead symbol survives extirpation:\n{_fmt(hits)}"


# #############################################################################
# LLM provider-runtime hard cutover (§14) — dropped-surface negative gates
#
# docs/cutovers/llm-provider-runtime-hard-cutover.md §14: "No models/user_api_keys
# table, /models, /keys, BYOK/key mode, provider enable flag, Cloudflare LLM,
# active old-model slug, generic provider-branch client, cache stripping, schema
# mutation, JSON repair, sampling knob, reasoning token budget, stateful cursor, or
# automatic fallback remains." Same grep idiom as every gate above: scan only
# python/nexus + apps/web/src and assert the dropped surface is ABSENT (migrations
# and python/tests/ live outside the roots; only frontend *.test.{ts,tsx} need
# excluding). These prove the LIVE cutover surface — services, schemas, API routes,
# tasks, models, config, and the whole frontend — is clean of every dropped symbol.
# #############################################################################


def test_models_and_user_api_keys_orm_tables_absent_from_live_code():
    # The DB `models` and `user_api_keys` tables and their ORM classes + the runtime
    # MODEL_CATALOG / nexus.llm_catalog module are gone (profiles replace them). Import
    # forms only, so the historical prose reference in chat_failure.py does not match.
    pattern = (
        r"\bclass Model\(|\bclass UserApiKey\b|"
        r"__tablename__\s*=\s*['\"](?:models|user_api_keys)['\"]|"
        r"\bMODEL_CATALOG\b|"
        r"(?:from|import)\s+nexus\.llm_catalog\b|"
        r"\bUserApiKey\b|\buser_api_keys\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"models/user_api_keys ORM+catalog surface in live code:\n{_fmt(hits)}"


def test_models_and_keys_routes_and_modules_absent():
    # GET /llm-profiles + the sole profiles router replace GET /models and the key
    # routes; the encryption/key-resolver services and the frontend BFF + settings pane
    # are deleted.
    deleted = [
        "python/nexus/api/routes/models.py",
        "python/nexus/api/routes/keys.py",
        "python/nexus/schemas/models.py",
        "python/nexus/schemas/keys.py",
        "python/nexus/services/models.py",
        "python/nexus/services/user_keys.py",
        "python/nexus/services/api_key_resolver.py",
        "python/nexus/services/crypto.py",
        "apps/web/src/app/api/models",
        "apps/web/src/app/api/keys",
        "apps/web/src/components/chat/ModelSettingsPopover.tsx",
    ]
    present = [rel for rel in deleted if (_REPO_ROOT / rel).exists()]
    assert not present, f"deleted model/key route+service+BFF modules still exist: {present}"

    route_hits = _filtered(
        r"@router\.(?:get|post|put|delete|patch)\(\s*['\"]/(?:models|keys)\b|"
        r"proxyToFastAPI\([^)\n]*[`'\"]/(?:models|keys)\b",
        _PY_ROOT,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not route_hits, f"/models or /keys route literal survives:\n{_fmt(route_hits)}"


def test_byok_and_key_mode_absent_from_live_surface():
    # BYOK / key-mode / per-user key encryption are gone (platform credentials only).
    # Symbol-precise (not bare prose) so the llm_credentials docstring that names what
    # it replaced, and unrelated Web Crypto, do not match.
    pattern = (
        r"\bKeyModeRequested\b|\bKeyModeUsed\b|\bApiKeyStatus\b|\bbyok_only\b|\bbyok\b|"
        r"\bencrypt_api_key\b|\bdecrypt_api_key\b|"
        r"(?:from|import)\s+nexus\.services\.(?:api_key_resolver|user_keys|crypto)\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"BYOK/key-mode/key-encryption surface in live code:\n{_fmt(hits)}"


def test_agency_setup_does_not_regenerate_removed_byok_encryption_key():
    setup = (_REPO_ROOT / "scripts" / "agency_setup.sh").read_text(encoding="utf-8")
    assert "NEXUS_KEY_ENCRYPTION_KEY" not in setup
    assert "NEXUS_RESET_KEY_ENCRYPTION_KEY" not in setup


def test_provider_enable_flags_absent_from_live_surface():
    # §4/§14: missing platform config is a startup error, never a product-portfolio
    # toggle — there is no per-provider enable flag.
    pattern = (
        r"\benable_(?:openai|anthropic|gemini|openrouter|cloudflare|moonshot)\b|"
        r"\bENABLE_(?:OPENAI|ANTHROPIC|GEMINI|OPENROUTER|CLOUDFLARE|MOONSHOT)\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"provider-enable flag in live code:\n{_fmt(hits)}"


def test_cloudflare_llm_absent_from_live_surface():
    # Cloudflare LLM (Workers AI) is removed. Cloudflare R2 object storage and the
    # Cloudflare Email Worker ingest are unrelated infrastructure and stay legitimate,
    # so this bans only the LLM-provider forms.
    pattern = (
        r"\bLLMProvider\b|@cf/|\bcloudflare_ai\b|"
        r"\bCLOUDFLARE_AI_API_TOKEN\b|\bCLOUDFLARE_AI_ACCOUNT_ID\b|\bcloudflare_ai_api_token\b|"
        r"provider\s*=\s*['\"]cloudflare['\"]"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"Cloudflare LLM surface in live code:\n{_fmt(hits)}"


def test_llm_profile_targets_current_and_no_retired_model_slug_active():
    # §4: the profile registry maps to exactly the seven certified runtime targets…
    profiles_src = (_PY_ROOT / "services" / "llm_profiles.py").read_text(encoding="utf-8")
    for slug in (
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "claude-sonnet-5",
        "claude-fable-5",
        "gemini-3.5-flash",
        "kimi-k3",
    ):
        assert slug in profiles_src, f"current runtime target {slug!r} missing from llm_profiles.py"

    # …and no retired GPT/Claude/Gemini/Kimi/Cloudflare/DeepSeek slug is an active target
    # anywhere in the LLM selection/execution/runtime surface. (redact.py's safe_kv
    # docstring example is a logging-guard illustration, not an active target, and is not
    # part of this surface.)
    retired = (
        r"gpt-4|gpt-3|claude-3|claude-haiku|claude-opus|gemini-1\.|gemini-2\.|kimi-k2|deepseek|@cf/"
    )
    llm_surface = (
        _PY_ROOT / "services" / "llm_profiles.py",
        _PY_ROOT / "services" / "llm_execution.py",
        _PY_ROOT / "services" / "llm_credentials.py",
        _PY_ROOT / "schemas" / "llm.py",
        _PY_ROOT / "api" / "routes" / "llm_profiles.py",
    )
    hits = _grep(retired, *llm_surface)
    assert not hits, (
        f"retired model slug active in the LLM selection/runtime surface:\n{_fmt(hits)}"
    )


def test_generic_provider_branch_client_absent_from_live_code():
    # §7/§12: no generic provider-branching OpenAI-compatible client / adapter runtime.
    # Moonshot + OpenRouter share only private syntax-only Chat Completions wire parsers
    # inside the shared runtime package; Nexus never imports a branching client.
    pattern = (
        r"\bopenai_compatible\b|\bOpenAICompatible\b|\bopenai_compat\b|"
        r"\b_adapter_runtime\b|\bProviderBranch\b|\bprovider_branch\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"generic provider-branch client surface in live code:\n{_fmt(hits)}"


def test_cache_stripping_schema_mutation_and_json_repair_absent():
    # §5/§8/§12: schema is validated once and never rewritten; unsupported cache intent
    # is a planning defect, never silently stripped; there is no JSON/tool-argument
    # repair and the json-repair dependency is gone.
    pattern = (
        r"json[_-]?repair|repair_json|strip_unsupported|strip_cache|strip_cache_control|"
        r"normalize_schema|force_add_required|add_required_fields"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        f"cache-stripping / schema-mutation / JSON-repair surface in live code:\n{_fmt(hits)}"
    )


def test_sampling_knobs_absent_from_live_code():
    # §2/§7: sampling is provider-default and not a product setting; Nexus omits native
    # sampling fields. Word-anchored so substrings like stopPropagation / top_peers /
    # topPadding do not match.
    pattern = (
        r"\btemperature\b|\btop_p\b|\btop_k\b|\bpresence_penalty\b|\bfrequency_penalty\b|"
        r"\btopP\b|\btopK\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"sampling knob in live code:\n{_fmt(hits)}"


def test_reasoning_token_budget_absent_from_live_code():
    # §2/§9: no generalized reasoning-token budget. The legitimate current concept is
    # `reasoning_reserve_tokens` (a catalog-declared ledger reservation), which is NOT a
    # caller-set budget and is deliberately not matched here.
    pattern = (
        r"reasoning_token_budget|thinking_budget|thinkingBudget|"
        r"max_reasoning_tokens|reasoning_max_tokens"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"reasoning-token budget in live code:\n{_fmt(hits)}"


def test_automatic_provider_fallback_absent_from_live_code():
    # §9/§14: no cross-model, cross-provider, or OpenRouter upstream fallback. (The
    # OpenRouter codec pins allow_fallbacks=false inside the shared runtime package, not
    # in Nexus.) The generic word "fallback" is intentionally not banned — only the
    # provider/model-routing forms.
    pattern = (
        r"\ballow_fallbacks\b|\bauto_fallback\b|\bautomatic_fallback\b|"
        r"\bfallback_model\b|\bfallback_provider\b|\bmodel_fallback\b|\bprovider_fallback\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"automatic provider/model fallback in live code:\n{_fmt(hits)}"


# Universal Link Authoring hard cutover
# (docs/cutovers/universal-link-authoring-hard-cutover.md, AC23/AC25)
#
# Same grep idiom as every section above: python/nexus + apps/web/src only —
# migrations/ (repo-root) and python/tests/ sit outside the scanned roots, so
# only frontend *.test.{ts,tsx} files need excluding. AC23 gates are ABSENCE
# (a deleted picker/search-lane/writer/mapper/allowlist survives); AC25 gates
# are PRESENCE (a new retry constraint, error code, or scheme-CHECK is
# registered) plus a self-check that the deep scheme/capability/search parity
# tests still exist (their own bodies do the parity work; see
# resourceGraph/contractParity.test.ts and search/contractParity.test.ts).
# #############################################################################


# =============================================================================
# AC23 — deleted files stay deleted
# =============================================================================


@pytest.mark.parametrize(
    "rel_path",
    [
        # Cite picker/composer (spec Consolidation And Deletion).
        "apps/web/src/components/reader/CitePicker.tsx",
        "apps/web/src/components/reader/CitePicker.module.css",
        "apps/web/src/components/reader/CitePicker.test.tsx",
        "apps/web/src/lib/reader/useCiteComposer.ts",
        # ObjectRef search/resolve/autocomplete surface.
        "apps/web/src/components/notes/ObjectRefAutocomplete.tsx",
        "apps/web/src/components/notes/ObjectRefAutocomplete.module.css",
        "apps/web/src/lib/objectRefs.ts",
        "apps/web/src/lib/objectRefs.test.ts",
        "apps/web/src/app/api/object-refs/resolve/route.ts",
        "apps/web/src/app/api/object-refs/search/route.ts",
        "python/nexus/api/routes/object_refs.py",
        "python/nexus/services/object_refs.py",
        "python/tests/test_object_refs_routes.py",
        # Generic public edge writer.
        "apps/web/src/lib/resourceGraph/edges.ts",
        "apps/web/src/lib/resourceGraph/edges.test.ts",
        "apps/web/src/app/api/resource-graph/edges/route.ts",
        "apps/web/src/app/api/resource-graph/edges/[edgeId]/route.ts",
    ],
)
def test_universal_link_authoring_deleted_files_absent(rel_path: str):
    assert not (_REPO_ROOT / rel_path).exists(), (
        f"{rel_path} must be deleted (universal-link-authoring hard cutover)"
    )


def test_cite_picker_and_object_ref_autocomplete_not_imported():
    # File non-existence above proves the components themselves are gone;
    # this proves no straggler import/JSX-usage/hook-call survives elsewhere
    # either. Matched by import/usage FORM (an import specifier, a JSX tag
    # open, a hook call), not the bare identifier — a design-note comment
    # comparing a new component to the old CitePicker by name (legitimate
    # historical-lineage prose, same spirit as this file's own "the old
    # /resource-graph/edges route" style landmine notes) is not what this
    # gate polices; a live reference is.
    pattern = (
        r'from\s+["\'][^"\']*\bCitePicker["\']|<CitePicker\b|'
        r'\buseCiteComposer\(|from\s+["\'][^"\']*useCiteComposer["\']|'
        r'from\s+["\'][^"\']*ObjectRefAutocomplete["\']|<ObjectRefAutocomplete\b'
    )
    hits = _filtered(pattern, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, (
        f"a deleted Cite/ObjectRefAutocomplete surface is still imported/used:\n{_fmt(hits)}"
    )


def test_object_ref_search_resolve_surface_absent():
    pattern = (
        r"\bsearchObjectRefs\(|\bresolveObjectRefs\(|"
        r"/object-refs/search|/object-refs/resolve|"
        r'from\s+["\'][^"\']*\blib/objectRefs["\']'
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"ObjectRef search/resolve surface still referenced:\n{_fmt(hits)}"


def test_public_generic_edge_writer_absent():
    # POST/DELETE /resource-graph/edges and the frontend createUserEdge/
    # deleteUserEdge client are deleted; resource_graph.edges/create_edge
    # remains only as the internal low-level writer (spec, Mutation APIs >
    # Stance: "resource_graph.edges remains the internal low-level writer").
    # The unused request schema behind the deleted route must go too — a dead
    # DTO whose docstring names a route that no longer exists is exactly the
    # residue this gate exists to catch.
    pattern = (
        r"\bcreateUserEdge\(|\bdeleteUserEdge\(|"
        r'from\s+["\'][^"\']*resourceGraph/edges["\']|'
        r"/resource-graph/edges\b"
    )
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"public generic edge writer still referenced:\n{_fmt(hits)}"

    schema_src = (_PY_ROOT / "schemas" / "resource_graph.py").read_text(encoding="utf-8")
    assert "class CreateEdgeRequest" not in schema_src, (
        "CreateEdgeRequest is dead: the POST /resource-graph/edges route it "
        "served is deleted; delete the unused request schema too"
    )


def test_client_target_result_to_resource_ref_mapper_absent():
    # citableRefForRow inferred a ResourceRef from a search result's `type`
    # field client-side (Consolidation And Deletion: "frontend
    # citableRefForRow inference"). Target search rule 9 / AC9 replaces it —
    # the backend resolves and returns the ref; the client never derives one
    # (see resourceTargets.ts's own "never maps a search-result type to a
    # ResourceRef" docstring).
    hits = _filtered(r"\bcitableRefForRow\b", _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"client-side search-result-to-ResourceRef mapper survives:\n{_fmt(hits)}"


def test_refresh_lifecycles_do_not_delete_highlights():
    # Invariant 9 / "Highlight Durability": web/EPUB/transcript-current and
    # podcast-transcription refresh must never delete a Highlight row; only
    # explicit owner cleanup (media/note deletion) does.
    refresh_files = (
        _PY_ROOT / "services" / "web_article_artifacts.py",
        _PY_ROOT / "services" / "epub_lifecycle.py",
        _PY_ROOT / "services" / "transcripts" / "current.py",
        _PY_ROOT / "services" / "podcasts" / "transcription.py",
    )
    pattern = r"\bdelete_highlight\(|\bdelete_highlight_rows\(|DELETE\s+FROM\s+highlights\b"
    hits = _grep(pattern, *refresh_files)
    assert not hits, f"refresh-time Highlight deletion survives:\n{_fmt(hits)}"


def test_consumer_scheme_allowlist_alias_absent():
    # Capability Contract: "Replace ambiguous `linkable` with an explicit
    # graph sub-policy; do not keep an alias." (No per-consumer hand-rolled
    # linkable-scheme registry may survive outside the one capability owner
    # either — test_local_resource_capability_lists_absent_outside_capability_owner
    # above already polices the *_RESOURCE_SCHEMES registries by name; this
    # closes the narrower alias-name gap this cutover specifically forbids.)
    hits = _filtered(
        r"\bresourceSchemeIsLinkable\b|\.linkable\b",
        _PY_ROOT,
        _WEB_ROOT,
        exclude=_FRONTEND_TEST,
    )
    assert not hits, f"dropped 'linkable' alias survives on a consumer:\n{_fmt(hits)}"


# =============================================================================
# AC25 — new retry constraints, error codes, and scheme CHECKs are registered
# =============================================================================


def test_retryable_unique_constraints_include_universal_link_authoring_shapes():
    from nexus.db.retries import RETRYABLE_UNIQUE_CONSTRAINTS

    for name in (
        "uq_passage_anchors_identity",
        "uq_resource_edges_user_context_link_pair",
        "uq_resource_edges_user_stance_directed_pair",
        "highlights_pkey",
    ):
        assert name in RETRYABLE_UNIQUE_CONSTRAINTS, (
            f"{name} missing from RETRYABLE_UNIQUE_CONSTRAINTS"
        )


def test_link_error_codes_registered():
    from nexus.errors import ERROR_CODE_TO_STATUS, ApiErrorCode

    expected_status = {
        "E_LINK_SELF": 422,
        "E_LINK_CAPABILITY": 422,
        "E_LINK_TARGET_AMBIGUOUS": 422,
        "E_LINK_TARGET_STALE": 409,
    }
    for name, status in expected_status.items():
        code = getattr(ApiErrorCode, name, None)
        assert code is not None, f"errors.py is missing {name}"
        assert ERROR_CODE_TO_STATUS[code] == status, f"{name} is not mapped to HTTP {status}"


# The closed contracts passage_anchor's scheme must be admitted into: two
# resource_edges direction CHECKs, one resource_versions CHECK, two
# resource_view_states CHECKs, and both chat_run_turn_contexts CHECKs
# (passage_anchor IS a chat subject, capability chat_subject="quote" — S1
# outcome, PLAN.md). Seven total, across 4 tables.
_PASSAGE_ANCHOR_ADMITTING_CHECKS: tuple[str, ...] = (
    "ck_resource_edges_source_scheme",
    "ck_resource_edges_target_scheme",
    "ck_resource_versions_resource_scheme",
    "ck_resource_view_states_surface_scheme",
    "ck_resource_view_states_target_scheme",
    "ck_chat_run_turn_contexts_requested_subject_scheme",
    "ck_chat_run_turn_contexts_subject_scheme",
)

# passage_anchor is deliberately NOT a search scope (S1 outcome, PLAN.md): it
# is unreachable through message_retrievals/synapse_suppressions by design, so
# these CHECKs must stay excluded rather than widen alongside the ones above.
_PASSAGE_ANCHOR_EXCLUDED_CHECKS: tuple[str, ...] = (
    "ck_message_retrievals_result_type",
    "ck_synapse_suppressions_source_scheme",
    "ck_synapse_suppressions_target_scheme",
)

_BARE_PASSAGE_ANCHOR = re.compile(r"(?<!oracle_)\bpassage_anchor\b")


def _check_constraint_body(models_src: str, constraint_name: str) -> str:
    idx = models_src.find(f'name="{constraint_name}"')
    assert idx != -1, f"{constraint_name} CHECK constraint is missing from db/models.py"
    start = models_src.rfind("CheckConstraint(", 0, idx)
    assert start != -1, f"{constraint_name} is not inside a CheckConstraint(...) call"
    return models_src[start:idx]


def test_passage_anchor_registered_in_closed_scheme_contracts():
    models_src = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    missing = [
        name
        for name in _PASSAGE_ANCHOR_ADMITTING_CHECKS
        if not _BARE_PASSAGE_ANCHOR.search(_check_constraint_body(models_src, name))
    ]
    assert not missing, f"passage_anchor scheme missing from CHECK(s): {missing}"


def test_passage_anchor_excluded_from_search_scope_scheme_checks():
    models_src = (_PY_ROOT / "db" / "models.py").read_text(encoding="utf-8")
    widened = [
        name
        for name in _PASSAGE_ANCHOR_EXCLUDED_CHECKS
        if _BARE_PASSAGE_ANCHOR.search(_check_constraint_body(models_src, name))
    ]
    assert not widened, (
        f"passage_anchor must stay excluded from these search-scope CHECK(s) "
        f"(S1 outcome, PLAN.md): {widened}"
    )


def test_backend_edge_origins_sanctioned_list_ends_with_link_note():
    # Mirrors secondApparatus.guards.test.ts's frontend EDGE_ORIGINS gate on
    # the backend single source (EdgeOrigin Literal, get_args-derived
    # EDGE_ORIGINS — test_edge_vocab_is_single_sourced proves the single
    # sourcing elsewhere); this pins the exact sanctioned 9-value list so a
    # stray tenth origin can't slip in unreviewed.
    from nexus.services.resource_graph.schemas import EDGE_ORIGINS

    assert EDGE_ORIGINS == (
        "user",
        "citation",
        "system",
        "note_body",
        "highlight_note",
        "synapse",
        "document_embed",
        "assistant",
        "link_note",
    )


def test_universal_link_authoring_contract_parity_tests_exist():
    # Deep scheme/backend-frontend capability parity (including the
    # resourceCapabilities.generated.ts nested user-relation policy) and
    # search result-taxonomy parity (including the `artifact` discriminant,
    # AC13) are each proven by their own dedicated test file's body; this
    # gate only ensures neither disappears out from under the contract.
    for rel_path in (
        "apps/web/src/lib/resourceGraph/contractParity.test.ts",
        "apps/web/src/lib/search/contractParity.test.ts",
    ):
        assert (_REPO_ROOT / rel_path).exists(), (
            f"{rel_path} must exist (scheme/capability/search parity, AC13/AC25)"
        )


# #############################################################################
# Reader-highlight quote-to-chat hard cutover (§Hard-Cut Deletions, AC-6/AC-20)
#
# The pre-cutover client-authored subject/quote contract is gone: no
# ChatSubjectRequest, no ReaderSelectionRequest carrying client exact/prefix/
# suffix, no chat_run_turn_contexts.reader_selection_* columns, no live-history
# _build_reader_selection_block, and no legacy top-level chat-run request fields
# (conversation_id/parent_message_id/branch_anchor/chat_subject). The reader
# quote is a durable ReaderSelectionKey + revision only; subject/companion are
# server-derived under the row lock. Same grep idiom as the sections above.
# #############################################################################


def _class_body(src: str, class_decl: str) -> str:
    """The source of one class, from its `class …:` line to the next top-level
    class (or end of file when it is the last class)."""
    start = src.index(class_decl)
    nxt = src.find("\nclass ", start + 1)
    return src[start:] if nxt == -1 else src[start:nxt]


def test_reader_selection_client_authored_symbols_absent_from_production():
    # The client-authored subject/quote request types and the live-history block
    # builder must not survive anywhere in production python or web code (scripts
    # included). The canonical snapshot owner keeps its own exact/prefix/suffix
    # (server-derived), so only the request-side symbols are banned here.
    pattern = r"\bChatSubjectRequest\b|\bReaderSelectionRequest\b|\b_build_reader_selection_block\b"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, _SCRIPTS_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"client-authored reader-selection symbols still present:\n{_fmt(hits)}"


def test_dropped_turn_context_reader_selection_columns_absent_from_runtime():
    # The chat_run_turn_contexts.reader_selection_* columns are dropped by 0189;
    # no LIVE runtime code (models/services/routes/web) may reference them. The
    # pre-migration remediation tool (python/scripts/remediate_reader_selection_
    # backfill.py) and migration 0189 legitimately name them because they run
    # against the pre-cutover schema — both live outside these runtime roots.
    pattern = r"\breader_selection_media_id\b|\breader_selection_highlight_id\b"
    hits = _filtered(pattern, _PY_ROOT, _WEB_ROOT, exclude=_FRONTEND_TEST)
    assert not hits, f"dropped turn-context reader-selection columns in runtime code:\n{_fmt(hits)}"


def test_chat_run_create_request_has_no_legacy_top_level_fields():
    # ChatRunCreateRequest is destination + reader_selection presence only; the old
    # top-level conversation_id / parent_message_id / branch_anchor / chat_subject
    # fields are gone (they moved into the tagged destination union).
    src = (_PY_ROOT / "schemas" / "conversation.py").read_text(encoding="utf-8")
    body = _class_body(src, "class ChatRunCreateRequest(BaseModel):")
    banned = [
        symbol
        for symbol in ("conversation_id", "parent_message_id", "branch_anchor", "chat_subject")
        if symbol in body
    ]
    assert not banned, f"ChatRunCreateRequest still declares legacy top-level fields: {banned}"


def test_reader_selection_input_carries_no_client_quote_text():
    # The request-side ReaderSelectionInput is key + revision only; client
    # exact/prefix/suffix send fields are gone (the server derives them from the
    # locked Highlight). The docstring may NAME them, but no field declares them.
    src = (_PY_ROOT / "schemas" / "chat_reader_selection.py").read_text(encoding="utf-8")
    body = _class_body(src, "class ReaderSelectionInput(BaseModel):")
    field = re.search(r"\b(exact|prefix|suffix)\s*:", body)
    assert field is None, (
        f"ReaderSelectionInput declares a client quote-text field: {field and field.group(0)!r}"
    )
