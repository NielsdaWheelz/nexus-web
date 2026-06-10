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
    # settings fields. semantic_chunks.py is the embeddings provider path — a
    # separate substrate with its own OpenAI key, not an LLM-generation surface,
    # and not part of the resolve_api_key spine (out of §14 scope).
    pattern = r"settings\.(anthropic|openai|gemini|deepseek)_api_key"
    hits = _excluding(
        _grep(pattern, _PY_ROOT),
        "llm_catalog.py",
        "services/api_key_resolver.py",
        "config.py",
        "services/semantic_chunks.py",
    )
    assert not hits, f"raw provider-key read outside the key spine:\n{_fmt(hits)}"


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


# =============================================================================
# Dead-symbol sweep (generation-run harness consolidations)
# =============================================================================


def test_generation_harness_dead_symbols_absent():
    # charge_token_budget (dead RateLimiter method), _unread_stream_api_error_code
    # (nexus router-exception patch, superseded by the llm-calling catch widening),
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
# AC-6 — USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS
#
# The authoritative guard already lives in test_config.py
# (test_user_facing_job_kinds_are_allowlisted). It is restated here as a §14 gate
# so the negative-gate suite is self-contained; both must hold.
# =============================================================================


def test_user_facing_job_kinds_subset_of_worker_allowlist():
    from nexus.config import DEFAULT_WORKER_ALLOWED_JOB_KINDS
    from nexus.jobs.registry import USER_FACING_JOB_KINDS

    allowed = {kind.strip() for kind in DEFAULT_WORKER_ALLOWED_JOB_KINDS.split(",") if kind.strip()}
    missing = set(USER_FACING_JOB_KINDS) - allowed
    assert not missing, f"user-facing job kinds not in the worker allowlist: {sorted(missing)}"


# =============================================================================
# Must-REMAIN (anti-over-deletion) for the generation-run harness
# =============================================================================


def test_generation_harness_must_remain_symbols_present():
    # Both SSE tailers stay (the two-tailer defense in _sse.py); the one token
    # estimator stays (char *budgets* are domain and orthogonal); chat keeps its
    # user-copy map. (message_retrievals/conversation_references/oracle_reading_passages/
    # object_links presence is covered by the parametrized must-REMAIN gate above.)
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
#      messageToCitationOuts family + the 526-line CitationOut rebuild — IS deleted;
#      citation_index now ships server-built CitationOut[]. We assert THAT instead.
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
    # Divergence 2: the FE-side CitationOut reconstruction is gone (server-built now).
    pattern = (
        r"messageToCitationOuts|citationIndexFromBlocks|targetRefFromRetrieval|retrievalBlocksOf"
    )
    hits = [hit for hit in _grep(pattern, _WEB_ROOT) if ".test." not in hit.path]
    assert not hits, f"FE citation-render reconstruction family still present:\n{_fmt(hits)}"


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
