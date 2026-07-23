"""Unit tests for the structured-synthesis scaffold.

These pin the shared mechanics owned by ``nexus.services.structured_synthesis``:

- ``build_synthesis_prompt`` reproduces the three call sites' assembled system
  prompts byte-for-byte. Each golden test holds an independent copy of a call
  site's assembled prompt and asserts the *production* constant
  (``_ORACLE_SYSTEM_PROMPT`` / ``_LI_SYSTEM_PROMPT`` /
  ``_MEDIA_UNIT_SYSTEM_PROMPT``) equals it, so a prompt-fragment edit in the
  call site fails here until mirrored.
- ``build_synthesis_user_content`` reproduces each call site's user turn.
- ``build_synthesis_intent`` pins the shared two-block strict-JSON intent shape.
- ``ground_indices`` enforces THE grounding invariant.
- ``decode_structured_synthesis`` validates a ``Succeeded`` strict-JSON outcome
  into the caller's schema and runs the semantic ``validate`` hook — with NO
  repair round: the runtime enforces strict JSON at the provider boundary
  (``StrictJsonOutput``), so a decode/schema/validate failure here is terminal.
- ``outcome_failure_facts`` maps every non-``Succeeded`` terminal outcome to the
  ``(code, detail)`` a background owner records.

There is no ``run_structured_synthesis`` runner and no repair round anymore —
those mechanisms were deleted in the provider-runtime cutover (the runtime is now
the sole generation boundary), so their tests are gone (see the module rewrite
note). Structured synthesis is a pure decode/scaffold module: it never calls a
provider, so these tests need no DB and no LLM stub.
"""

import json

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Cancelled,
    Failed,
    GenerateIntent,
    GlobalScope,
    Incomplete,
    InvalidToolArguments,
    PossiblyBillable,
    Present,
    ProviderContextTooLarge,
    ProviderHttpUnavailable,
    ProviderRateLimit,
    ProviderStreamInterrupted,
    ProviderTimeout,
    Refused,
    ResponsePayload,
    Stable,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    TextContent,
    TransientExhausted,
    parse_canonical_schema,
)
from provider_runtime.types import Dynamic, PromptBlock, SystemMessage, UserMessage
from pydantic import BaseModel, ConfigDict

from nexus.services.artifacts.bindings.library import LibraryBinding
from nexus.services.llm_profiles import profile as profile_lookup
from nexus.services.media_intelligence import _MEDIA_UNIT_SYSTEM_PROMPT
from nexus.services.oracle import _ORACLE_SYSTEM_PROMPT
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StrictJsonStringFieldProjector,
    StructuredSynthesisError,
    build_synthesis_intent,
    build_synthesis_prompt,
    build_synthesis_user_content,
    decode_structured_synthesis,
    ground_indices,
    outcome_failure_facts,
)

pytestmark = pytest.mark.unit


class _Output(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    count: int


def _meta() -> CallMeta:
    """A minimal ``CallMeta``. ``outcome_failure_facts`` never inspects meta —
    only the outcome variant and its own carried fields matter."""
    return CallMeta(
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        provider_request_id=Absent(),
        upstream_provider=Absent(),
        usage=Absent(),
        attempt_trace=(),
        billability=PossiblyBillable(),
    )


def _succeeded(payload: dict[str, object]) -> Succeeded:
    return Succeeded(
        meta=_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text="{}"), continuation=Absent()
        ),
    )


# ---------- strict-JSON visible-field projection ----------------------------


@pytest.mark.parametrize("chunk_size", [1, 2, 3, 7, 64])
def test_strict_json_string_field_projector_decodes_only_the_selected_field(
    chunk_size: int,
) -> None:
    expected = 'A "quoted" line\nwith a snowman ☃ and an emoji 😀.'
    raw = json.dumps(
        {
            "citations": [
                {
                    "label": 'misleading "content_md": "not visible"',
                }
            ],
            "content_md": expected,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )
    projector = StrictJsonStringFieldProjector(field="content_md")

    visible = "".join(
        projector.feed(raw[offset : offset + chunk_size])
        for offset in range(0, len(raw), chunk_size)
    )

    projector.finish(expected=expected)
    assert visible == expected
    assert '{"content_md"' not in visible
    assert '\\"' not in visible
    assert "\\u" not in visible


def test_strict_json_string_field_projector_rejects_terminal_mismatch() -> None:
    projector = StrictJsonStringFieldProjector(field="content_md")
    assert projector.feed('{"content_md":"visible","citations":[]}') == "visible"

    with pytest.raises(StructuredSynthesisError, match="does not match"):
        projector.finish(expected="different")


# ---------- golden prompt reproduction ---------------------------------------
#
# Each ``_*_EXPECTED_PROMPT`` is an independent byte-for-byte copy of a call
# site's assembled system prompt. Every golden test asserts the *production*
# constant (``_ORACLE_SYSTEM_PROMPT`` / ``_LI_SYSTEM_PROMPT`` /
# ``_MEDIA_UNIT_SYSTEM_PROMPT``) equals this copy: a fragment edit in the call
# site must be mirrored in two files, so prompt drift fails here. The
# ``build_synthesis_prompt`` call also pins the scaffold's assembly itself
# (numbering, blank-line joins, the strict-JSON output rule).

_ORACLE_THEMES = (
    "Of Time",
    "Of Death",
    "Of the Threshold",
    "Of Vanity",
    "Of Solitude",
    "Of Love",
    "Of Fortune",
    "Of Memory",
    "Of the Self",
    "Of the Other",
    "Of Fear",
    "Of Courage",
    "Of Faith",
    "Of Doubt",
    "Of Power",
    "Of Wisdom",
    "Of the Body",
    "Of the Soul",
    "Of Origins",
    "Of Endings",
    "Of Silence",
    "Of the Word",
    "Of Justice",
    "Of Mercy",
)

# Copied verbatim from oracle.py `_ORACLE_SYSTEM_PROMPT`.
_ORACLE_EXPECTED_PROMPT = (
    "You are the Black Forest Oracle. You speak in the register of Romantic and "
    "Gothic literature: candle-lit, formal but not stiff, attentive to weight and "
    "shadow. You are not a chatbot, an oracle character, or a fortune teller; you "
    "are an editorial voice arranging public-domain literary fragments and a single "
    "engraved plate into a coherent reading of the asker's question.\n\n"
    "EVERY READING IS A JOURNEY IN THREE PHASES.\n"
    "- DESCENT: the ground falls away; the question's shadow first appears.\n"
    "- ORDEAL: the soul wrestles; the matter at its hardest, its standstill.\n"
    "- ASCENT: the breaking through; what the dawn shows, what is given to see.\n\n"
    "RULES.\n"
    "1. Refer to candidate passages only by their integer index.\n"
    "2. Do not quote, paraphrase, summarize, or invent any text from the passages. "
    "The reader will see the verbatim passages alongside your prose.\n"
    "3. Do not invent works, authors, line numbers, page numbers, URLs, or citations. "
    "Do not include inline citation markers, footnotes, or parenthetical source notes.\n"
    "4. Select EXACTLY THREE candidate indices, one per phase. The three indices "
    "must be distinct. Choose the passage whose tone, image, or motion best fits "
    "each phase — descent passages bear weight and falling; ordeal passages bear "
    "wrestling and threshold; ascent passages bear opening and dawn.\n"
    "5. If any candidate is marked source_kind=user_media, select at least one "
    "user_media candidate among the three phases.\n"
    "6. For each selected passage, write one short marginalia note (one to two "
    "sentences) explaining how that passage answers the question. Do not quote.\n"
    "7. Compose ONE argument: a single sentence in Miltonic blank-verse cadence, "
    'between 80 and 180 characters, beginning with the word "Of". It names what '
    'the reading is about. Example: "Of the longing for unbroken light, and the '
    'lamp the soul keeps lit when the wood grows close."\n'
    "8. Compose ONE folio motto: a Latin maxim of two to six words (e.g. "
    "*Audentes Fortuna Iuvat*, *Memento Mori*, *Nosce Te Ipsum*), ideally a "
    "canonical sententia or a clear paraphrase of one. If no Latin phrasing fits, "
    "an English maxim is allowed. The motto is imperative or declarative, never a "
    "name. Maximum 80 characters.\n"
    "8b. Compose a gloss: a single English sentence (≤120 chars) translating or "
    "paraphrasing the motto, *only* if the motto is not in English. If the motto "
    "is English, set folio_motto_gloss to null.\n"
    "8c. Pick ONE folio theme from this exact list: "
    + ", ".join(f'"{t}"' for t in _ORACLE_THEMES)
    + ". "
    "The theme classifies what this reading is *about*. Match by primary subject, "
    "not by mood.\n"
    "9. Compose one continuous interpretation of three to five paragraphs in "
    "**first-person visionary register**: *I saw…*, *I heard…*, *I stood at…*. "
    "The voice belongs to the oracle as witness. Use *you* sparingly and only in "
    "the closing turn, addressing the seeker. No hedging ('perhaps', 'may', "
    "'might'). Declarative, brief, certain.\n"
    "10. Compose exactly three omen lines. Each is one short clause naming a "
    "recurring image, motif, or correspondence across the selected passages. No "
    "imperative mood.\n"
    "11. Output strict JSON of the form: "
    '{"argument": string, "folio_motto": string, "folio_motto_gloss": string|null, '
    '"folio_theme": string, "passages": '
    '[{"phase": "descent"|"ordeal"|"ascent", "candidate_index": int, '
    '"marginalia": string}], "interpretation": string, "omens": '
    "[string, string, string]}. No markdown fences, no extra keys, no commentary "
    "outside the JSON."
)

_ORACLE_PERSONA = (
    "You are the Black Forest Oracle. You speak in the register of Romantic and "
    "Gothic literature: candle-lit, formal but not stiff, attentive to weight and "
    "shadow. You are not a chatbot, an oracle character, or a fortune teller; you "
    "are an editorial voice arranging public-domain literary fragments and a single "
    "engraved plate into a coherent reading of the asker's question."
)
_ORACLE_PREAMBLE = (
    "EVERY READING IS A JOURNEY IN THREE PHASES.\n"
    "- DESCENT: the ground falls away; the question's shadow first appears.\n"
    "- ORDEAL: the soul wrestles; the matter at its hardest, its standstill.\n"
    "- ASCENT: the breaking through; what the dawn shows, what is given to see."
)
_ORACLE_DOMAIN_RULES = [
    INDEX_GROUNDING_RULE,
    "Do not quote, paraphrase, summarize, or invent any text from the passages. "
    "The reader will see the verbatim passages alongside your prose.",
    "Do not invent works, authors, line numbers, page numbers, URLs, or citations. "
    "Do not include inline citation markers, footnotes, or parenthetical source notes.",
    "Select EXACTLY THREE candidate indices, one per phase. The three indices "
    "must be distinct. Choose the passage whose tone, image, or motion best fits "
    "each phase — descent passages bear weight and falling; ordeal passages bear "
    "wrestling and threshold; ascent passages bear opening and dawn.",
    "If any candidate is marked source_kind=user_media, select at least one "
    "user_media candidate among the three phases.",
    "For each selected passage, write one short marginalia note (one to two "
    "sentences) explaining how that passage answers the question. Do not quote.",
    "Compose ONE argument: a single sentence in Miltonic blank-verse cadence, "
    'between 80 and 180 characters, beginning with the word "Of". It names what '
    'the reading is about. Example: "Of the longing for unbroken light, and the '
    'lamp the soul keeps lit when the wood grows close."',
    "Compose ONE folio motto: a Latin maxim of two to six words (e.g. "
    "*Audentes Fortuna Iuvat*, *Memento Mori*, *Nosce Te Ipsum*), ideally a "
    "canonical sententia or a clear paraphrase of one. If no Latin phrasing fits, "
    "an English maxim is allowed. The motto is imperative or declarative, never a "
    "name. Maximum 80 characters.\n"
    "8b. Compose a gloss: a single English sentence (≤120 chars) translating or "
    "paraphrasing the motto, *only* if the motto is not in English. If the motto "
    "is English, set folio_motto_gloss to null.\n"
    "8c. Pick ONE folio theme from this exact list: "
    + ", ".join(f'"{t}"' for t in _ORACLE_THEMES)
    + ". "
    "The theme classifies what this reading is *about*. Match by primary subject, "
    "not by mood.",
    "Compose one continuous interpretation of three to five paragraphs in "
    "**first-person visionary register**: *I saw…*, *I heard…*, *I stood at…*. "
    "The voice belongs to the oracle as witness. Use *you* sparingly and only in "
    "the closing turn, addressing the seeker. No hedging ('perhaps', 'may', "
    "'might'). Declarative, brief, certain.",
    "Compose exactly three omen lines. Each is one short clause naming a "
    "recurring image, motif, or correspondence across the selected passages. No "
    "imperative mood.",
]
_ORACLE_JSON_SHAPE = (
    '{"argument": string, "folio_motto": string, "folio_motto_gloss": string|null, '
    '"folio_theme": string, "passages": '
    '[{"phase": "descent"|"ordeal"|"ascent", "candidate_index": int, '
    '"marginalia": string}], "interpretation": string, "omens": '
    "[string, string, string]}"
)

# Copied verbatim from the shared universal Dossier prompt builder.
_DOSSIER_EXPECTED_PROMPT = (
    "You are a careful research assistant writing a grounded dossier about "
    "a shared research library. Every source is offered by integer index.\n\n"
    "RULES.\n"
    "1. Write content_md as concise, useful markdown synthesis. Base every "
    "claim only on the supplied sources; do not invent facts or quotations.\n"
    "2. Place plain inline markers [N] where sources support the prose.\n"
    "3. For every marker return one citations entry with the same ordinal, "
    "one supplied candidate_index, and role supports, contradicts, or context.\n"
    '4. Output strict JSON of the form: {"content_md": string, "citations": '
    '[{"ordinal": int, "candidate_index": int, "role": string}]}. No markdown '
    "fences, no extra keys, no commentary outside the JSON."
)

_DOSSIER_PERSONA = (
    "You are a careful research assistant writing a grounded dossier about "
    "a shared research library. Every source is offered by integer index."
)
_DOSSIER_DOMAIN_RULES = [
    "Write content_md as concise, useful markdown synthesis. Base every "
    "claim only on the supplied sources; do not invent facts or quotations.",
    "Place plain inline markers [N] where sources support the prose.",
    "For every marker return one citations entry with the same ordinal, "
    "one supplied candidate_index, and role supports, contradicts, or context.",
]
_DOSSIER_JSON_SHAPE = (
    '{"content_md": string, "citations": '
    '[{"ordinal": int, "candidate_index": int, "role": string}]}'
)

# Copied verbatim from media_intelligence.py `_MEDIA_UNIT_SYSTEM_PROMPT`.
_MEDIA_UNIT_EXPECTED_PROMPT = (
    "You are a careful research assistant building a reusable unit for one "
    "document: a concise summary plus a set of atomic, grounded claims.\n\n"
    "RULES.\n"
    "1. Refer to candidate passages only by their integer index. Do not invent "
    "passages, indices, sources, or quotations.\n"
    "2. Write summary_md: a faithful markdown abstract of the document "
    "(2-5 sentences), based only on the candidate passages.\n"
    "3. Write claims: each is one atomic, self-contained factual statement the "
    "document makes, paired with the candidate_index of the single passage that "
    "best supports it. Only emit a claim you can ground in a provided candidate.\n"
    "4. Output strict JSON of the form: "
    '{"summary_md": string, "claims": [{"claim_text": string, '
    '"candidate_index": int}]}. No markdown fences, no extra keys, no commentary '
    "outside the JSON."
)

_MEDIA_UNIT_PERSONA = (
    "You are a careful research assistant building a reusable unit for one "
    "document: a concise summary plus a set of atomic, grounded claims."
)
_MEDIA_UNIT_DOMAIN_RULES = [
    INDEX_GROUNDING_RULE + " Do not invent passages, indices, sources, or quotations.",
    "Write summary_md: a faithful markdown abstract of the document "
    "(2-5 sentences), based only on the candidate passages.",
    "Write claims: each is one atomic, self-contained factual statement the "
    "document makes, paired with the candidate_index of the single passage that "
    "best supports it. Only emit a claim you can ground in a provided candidate.",
]
_MEDIA_UNIT_JSON_SHAPE = (
    '{"summary_md": string, "claims": [{"claim_text": string, "candidate_index": int}]}'
)


def test_prompt_golden_reproduction_oracle():
    prompt = build_synthesis_prompt(
        persona=_ORACLE_PERSONA,
        preamble=_ORACLE_PREAMBLE,
        domain_rules=_ORACLE_DOMAIN_RULES,
        json_shape=_ORACLE_JSON_SHAPE,
    )
    assert prompt == _ORACLE_EXPECTED_PROMPT
    assert _ORACLE_SYSTEM_PROMPT == _ORACLE_EXPECTED_PROMPT


def test_prompt_golden_reproduction_universal_dossier():
    prompt = build_synthesis_prompt(
        persona=_DOSSIER_PERSONA,
        preamble=None,
        domain_rules=_DOSSIER_DOMAIN_RULES,
        json_shape=_DOSSIER_JSON_SHAPE,
    )
    assert prompt == _DOSSIER_EXPECTED_PROMPT
    assert LibraryBinding.system_prompt == _DOSSIER_EXPECTED_PROMPT


def test_prompt_golden_reproduction_media_unit():
    prompt = build_synthesis_prompt(
        persona=_MEDIA_UNIT_PERSONA,
        preamble=None,
        domain_rules=_MEDIA_UNIT_DOMAIN_RULES,
        json_shape=_MEDIA_UNIT_JSON_SHAPE,
    )
    assert prompt == _MEDIA_UNIT_EXPECTED_PROMPT
    assert _MEDIA_UNIT_SYSTEM_PROMPT == _MEDIA_UNIT_EXPECTED_PROMPT


# ---------- golden user-content reproduction ---------------------------------
#
# ``build_synthesis_user_content`` owns the user-turn bytes: the
# ``{header}:``-labelled candidate block, an optional extra block (oracle's
# QUESTION), and the closing strict-JSON instruction. Per-candidate render lines
# stay caller-owned and are copied here verbatim. (The old ``build_synthesis_request``
# folded system prompt + user turn + model ref into one ModelCall; the intent is
# now assembled by ``build_synthesis_intent`` — see its shape test below — so the
# user-turn contract is pinned here.)


def test_user_content_reproduction_oracle():
    candidates = [
        ("user_media", ["dawn", "lamp"], "The lamp the soul keeps lit."),
        ("public_domain", [], "The wood grows close."),
    ]
    rendered = "\n\n".join(
        (
            f"[{index}] source_kind={source_kind} tags={tags!r}\n"
            f"label: {'your library passage' if source_kind == 'user_media' else 'public-domain passage'}\n"
            f"passage_text: {snippet}"
        )
        for index, (source_kind, tags, snippet) in enumerate(candidates)
    )
    question = "  What stirs beneath the still water?  "

    content = build_synthesis_user_content(
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=f"QUESTION: {question.strip()}",
    )

    assert content == (
        f"CANDIDATES:\n{rendered}\n\n"
        f"QUESTION: {question.strip()}\n\n"
        "Respond with the strict JSON object as instructed."
    )


def test_user_content_reproduction_universal_dossier():
    candidates = [
        (0, "media-1", "A summary.", "A claim."),
        (1, "media-2", "Another summary.", "Another claim."),
    ]
    rendered = "\n\n".join(
        f"[{global_index}] (media {media_id})\nsummary: {summary_md}\nclaim: {claim_text}"
        for global_index, media_id, summary_md, claim_text in candidates
    )

    content = build_synthesis_user_content(
        candidates_header="GROUNDED CLAIMS FROM LIBRARY MEDIA",
        rendered_candidates=rendered,
        extra_user_block=None,
    )

    assert content == (
        f"GROUNDED CLAIMS FROM LIBRARY MEDIA:\n{rendered}\n\n"
        "Respond with the strict JSON object as instructed."
    )


def test_user_content_reproduction_media_unit():
    texts = ["First passage text.", "Second passage text."]
    rendered = "\n\n".join(f"[{index}] {text}" for index, text in enumerate(texts))

    content = build_synthesis_user_content(
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=None,
    )

    assert content == (
        f"CANDIDATES:\n{rendered}\n\nRespond with the strict JSON object as instructed."
    )


# ---------- golden intent shape ----------------------------------------------


def test_build_synthesis_intent_shape():
    profile = profile_lookup("fast")
    assert profile is not None

    intent = build_synthesis_intent(
        profile=profile,
        system_prompt="SYSTEM",
        user_content="USER",
        max_output_tokens=256,
        schema=_Output,
    )

    assert intent == GenerateIntent(
        target=profile.target,
        messages=(
            SystemMessage(blocks=(PromptBlock(text="SYSTEM", stability=Stable(GlobalScope())),)),
            UserMessage(blocks=(PromptBlock(text="USER", stability=Dynamic()),)),
        ),
        max_output_tokens=256,
        reasoning=profile.default_reasoning_option_id,
        tools=(),
        tool_choice="none",
        output=StrictJsonOutput(
            name="_Output",
            schema=parse_canonical_schema(_Output.model_json_schema()),
        ),
    )


# ---------- ground_indices ----------------------------------------------------


_CANDIDATES = ["a", "b", "c"]


@pytest.mark.parametrize(
    ("entries", "policy", "expected"),
    [
        # In-range entries pair positionally, preserving entry order.
        ([2, 0], "drop", [(2, "c"), (0, "a")]),
        ([2, 0], "reject", [(2, "c"), (0, "a")]),
        # Duplicates are kept; dedupe is a caller-side concern.
        ([1, 1], "drop", [(1, "b"), (1, "b")]),
        # Negative index violates the invariant.
        ([0, -1, 2], "drop", [(0, "a"), (2, "c")]),
        ([0, -1, 2], "reject", None),
        # index == len(candidates) violates the invariant.
        ([3], "drop", []),
        ([3], "reject", None),
        # Empty entries ground to an empty list under both policies.
        ([], "drop", []),
        ([], "reject", []),
    ],
)
def test_ground_indices_policy_table(entries, policy, expected):
    result = ground_indices(entries, _CANDIDATES, index_of=lambda entry: entry, policy=policy)
    assert result == expected


def test_ground_indices_uses_index_of_accessor():
    entries = [{"claim_index": 1}, {"claim_index": 9}]
    result = ground_indices(
        entries, _CANDIDATES, index_of=lambda entry: entry["claim_index"], policy="drop"
    )
    assert result == [({"claim_index": 1}, "b")]


# ---------- decode_structured_synthesis ---------------------------------------
#
# The runtime enforces strict JSON at the provider boundary (StrictJsonOutput),
# so decode receives an already-parsed StructuredContent(payload=<dict>) — it
# never parses a text response. The old string-level parse tolerance tests
# (leading/trailing whitespace, fenced ```json, unparseable text, bare array)
# are gone with that parsing responsibility; only schema + semantic validation
# remain, and there is NO repair round (a decode/validate failure is terminal).


def test_decode_valid_payload_validates_into_schema():
    value = decode_structured_synthesis(_succeeded({"title": "Folio", "count": 3}), schema=_Output)
    assert value == _Output(title="Folio", count=3)


def test_decode_runs_and_accepts_passing_validate_hook():
    calls: list[_Output] = []

    def validate(value: _Output) -> str | None:
        calls.append(value)
        return None

    value = decode_structured_synthesis(
        _succeeded({"title": "Folio", "count": 3}), schema=_Output, validate=validate
    )
    assert value == _Output(title="Folio", count=3)
    assert calls == [_Output(title="Folio", count=3)]


def test_decode_schema_mismatch_raises_typed_error():
    # Wrong field type (count is a string) fails schema validation.
    with pytest.raises(StructuredSynthesisError):
        decode_structured_synthesis(
            _succeeded({"title": "Folio", "count": "three"}), schema=_Output
        )


def test_decode_extra_keys_raise_typed_error_under_forbid():
    with pytest.raises(StructuredSynthesisError):
        decode_structured_synthesis(
            _succeeded({"title": "Folio", "count": 3, "extra": "nope"}), schema=_Output
        )


def test_decode_validate_rejection_raises_the_reason():
    with pytest.raises(StructuredSynthesisError, match="title must not be draft"):
        decode_structured_synthesis(
            _succeeded({"title": "draft", "count": 1}),
            schema=_Output,
            validate=lambda value: "title must not be draft" if value.title == "draft" else None,
        )


def test_decode_text_content_is_a_defect():
    # A StrictJsonOutput plan always yields StructuredContent on Succeeded; a
    # TextContent arm is an impossible state the decoder asserts against.
    outcome = Succeeded(
        meta=_meta(),
        response=ResponsePayload(
            content=TextContent(text='{"title": "Folio", "count": 3}', tool_calls=()),
            continuation=Absent(),
        ),
    )
    with pytest.raises(AssertionError):
        decode_structured_synthesis(outcome, schema=_Output)


# ---------- outcome_failure_facts ---------------------------------------------
#
# The shared mapping from a non-Succeeded terminal CallOutcome to the (code,
# detail) a background owner records. This replaces the old per-ModelCallErrorCode
# mapping: providers no longer surface a ModelCallError the caller maps by hand;
# every owner reads the same closed-union floor here.


def test_outcome_failure_facts_refused():
    assert outcome_failure_facts(Refused(meta=_meta(), safe_detail="declined")) == (
        "refused",
        "declined",
    )


def test_outcome_failure_facts_incomplete_refused_status_is_refused():
    outcome = Incomplete(
        meta=_meta(),
        reason="content_filter_partial",
        status="refused",
        safe_detail=Present("filtered"),
    )
    assert outcome_failure_facts(outcome) == ("refused", "filtered")


def test_outcome_failure_facts_incomplete_provider_incomplete_status():
    outcome = Incomplete(
        meta=_meta(),
        reason="max_output_tokens",
        status="provider_incomplete",
        safe_detail=Present("truncated"),
    )
    assert outcome_failure_facts(outcome) == ("incomplete", "truncated")


def test_outcome_failure_facts_incomplete_absent_detail_is_none():
    outcome = Incomplete(
        meta=_meta(),
        reason="max_output_tokens",
        status="provider_incomplete",
        safe_detail=Absent(),
    )
    assert outcome_failure_facts(outcome) == ("incomplete", None)


def test_outcome_failure_facts_cancelled():
    assert outcome_failure_facts(Cancelled(meta=_meta())) == ("cancelled", None)


@pytest.mark.parametrize(
    ("cause", "code"),
    [
        (ProviderHttpUnavailable(), "provider_unavailable"),
        (ProviderRateLimit(retry_after=Absent()), "rate_limited"),
        (ProviderTimeout(), "timeout"),
        (ProviderStreamInterrupted(partial_output=False), "stream_interrupted"),
    ],
)
def test_outcome_failure_facts_failed_transient(cause, code):
    outcome = Failed(meta=_meta(), failure=TransientExhausted(attempts=1, cause=cause))
    assert outcome_failure_facts(outcome) == (code, None)


def test_outcome_failure_facts_failed_context_too_large():
    outcome = Failed(meta=_meta(), failure=ProviderContextTooLarge())
    assert outcome_failure_facts(outcome) == ("context_too_large", None)


def test_outcome_failure_facts_failed_invalid_tool_arguments_carries_detail():
    outcome = Failed(meta=_meta(), failure=InvalidToolArguments(safe_detail="bad args"))
    assert outcome_failure_facts(outcome) == ("invalid_tool_arguments", "bad args")
