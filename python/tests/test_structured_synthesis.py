"""Unit tests for the structured-synthesis scaffold + runner.

These pin the shared mechanics: ``build_synthesis_prompt`` /
``build_synthesis_request`` reproduce the three call sites' assembled prompts
and request turns byte-for-byte. Each golden test holds an independent copy of
a call site's assembled system prompt and asserts the *production* constant
(``_ORACLE_SYSTEM_PROMPT`` / ``_LI_SYSTEM_PROMPT`` /
``_MEDIA_UNIT_SYSTEM_PROMPT``) equals it, so a prompt-fragment edit in the call
site fails here until mirrored. ``ground_indices`` enforces THE grounding
invariant, and ``run_structured_synthesis`` makes one ``llm.generate`` call
plus at most ONE bounded repair round (parse/schema failure or semantic
``validate`` rejection) with usage summed across attempts. Provider-call errors
(``ModelCallError``) propagate unchanged and are never repaired. The fake routers
stand in for the external LLM provider boundary (the only mock allowed here).
"""

import json
from dataclasses import replace

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelRef,
    ModelResponse,
    ReasoningConfig,
    TokenUsage,
)
from pydantic import BaseModel, ConfigDict

from nexus.services.artifacts.reducers.library_dossier import _LI_SYSTEM_PROMPT
from nexus.services.media_intelligence import _MEDIA_UNIT_SYSTEM_PROMPT
from nexus.services.oracle import _ORACLE_SYSTEM_PROMPT
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StructuredSynthesisError,
    SynthesisRequest,
    build_synthesis_prompt,
    build_synthesis_request,
    ground_indices,
    run_structured_synthesis,
)

pytestmark = pytest.mark.unit


class _Output(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    title: str
    count: int


class _FakeRouter:
    """Returns the same canned response for every ``generate`` call."""

    def __init__(self, response: ModelResponse) -> None:
        self.response = response
        self.calls = 0

    async def generate(self, _request, *, key, timeout_s):
        self.calls += 1
        return self.response


class _ScriptedRouter:
    """Plays scripted responses (or raises scripted errors) in order, capturing requests."""

    def __init__(self, script: list[ModelResponse | ModelCallError]) -> None:
        self.script = list(script)
        self.requests: list[ModelCall] = []

    async def generate(self, request, *, key, timeout_s):
        self.requests.append(request)
        item = self.script.pop(0)
        if isinstance(item, ModelCallError):
            raise item
        return item


class _RaisingRouter:
    """Raises a provider error for every ``generate`` call."""

    def __init__(self, error: ModelCallError) -> None:
        self.error = error
        self.calls = 0

    async def generate(self, _request, *, key, timeout_s):
        self.calls += 1
        raise self.error


def _request() -> SynthesisRequest:
    return SynthesisRequest(
        provider="anthropic",
        llm_request=ModelCall(
            model=ModelRef(provider="anthropic", model="claude-haiku-4-5-20251001"),
            messages=[ModelMessage(role="user", content="hi")],
            max_output_tokens=128,
            reasoning=ReasoningConfig(effort="none"),
        ),
        api_key="sk-test",
        timeout_s=30,
    )


def _response(text: str, *, usage: TokenUsage | None = None, request_id: str | None = None):
    return ModelResponse(text=text, usage=usage, provider_request_id=request_id)


def _repair_turns(raw: str, reason: str) -> list[ModelMessage]:
    """The exact two turns the repair round appends (pinned copy)."""
    return [
        ModelMessage(role="assistant", content=raw),
        ModelMessage(
            role="user",
            content=(
                f"Your previous response was invalid: {reason}. "
                "Respond again with only the corrected strict JSON object as instructed."
            ),
        ),
    ]


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

# Copied verbatim from library_intelligence_reduce.py `_LI_SYSTEM_PROMPT`.
_LI_EXPECTED_PROMPT = (
    "You are a careful research assistant writing a whole-library synthesis from "
    "per-document claims. Each claim is offered by integer index.\n\n"
    "RULES.\n"
    "1. Write content_md: faithful markdown synthesis prose covering an overview, "
    "key topics, key sources, a reading path, cross-source tensions, and open "
    "questions. Use prose, not rigid sections. Base every statement only on the "
    "provided claims.\n"
    "2. Place inline citation markers [N] in the prose where a claim supports the "
    "statement, where N is the ordinal you assign in citations.\n"
    "3. Write citations: for each [N], one entry {ordinal:N, claim_index:int, "
    "role:'supports'|'contradicts'|'context'} where claim_index is the integer "
    "index of the single provided claim it cites. Never cite an index you were not "
    "given.\n"
    '4. Output strict JSON of the form: {"content_md": string, "citations": '
    '[{"ordinal": int, "claim_index": int, "role": string}]}. No markdown '
    "fences, no extra keys, no commentary outside the JSON."
)

_LI_PERSONA = (
    "You are a careful research assistant writing a whole-library synthesis from "
    "per-document claims. Each claim is offered by integer index."
)
_LI_DOMAIN_RULES = [
    "Write content_md: faithful markdown synthesis prose covering an overview, "
    "key topics, key sources, a reading path, cross-source tensions, and open "
    "questions. Use prose, not rigid sections. Base every statement only on the "
    "provided claims.",
    "Place inline citation markers [N] in the prose where a claim supports the "
    "statement, where N is the ordinal you assign in citations.",
    "Write citations: for each [N], one entry {ordinal:N, claim_index:int, "
    "role:'supports'|'contradicts'|'context'} where claim_index is the integer "
    "index of the single provided claim it cites. Never cite an index you were not "
    "given.",
]
_LI_JSON_SHAPE = (
    '{"content_md": string, "citations": [{"ordinal": int, "claim_index": int, "role": string}]}'
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


def test_prompt_golden_reproduction_li_reduce():
    prompt = build_synthesis_prompt(
        persona=_LI_PERSONA,
        preamble=None,
        domain_rules=_LI_DOMAIN_RULES,
        json_shape=_LI_JSON_SHAPE,
    )
    assert prompt == _LI_EXPECTED_PROMPT
    assert _LI_SYSTEM_PROMPT == _LI_EXPECTED_PROMPT


def test_prompt_golden_reproduction_media_unit():
    prompt = build_synthesis_prompt(
        persona=_MEDIA_UNIT_PERSONA,
        preamble=None,
        domain_rules=_MEDIA_UNIT_DOMAIN_RULES,
        json_shape=_MEDIA_UNIT_JSON_SHAPE,
    )
    assert prompt == _MEDIA_UNIT_EXPECTED_PROMPT
    assert _MEDIA_UNIT_SYSTEM_PROMPT == _MEDIA_UNIT_EXPECTED_PROMPT


# ---------- golden request reproduction --------------------------------------
#
# Expected requests are built with the current call-site builder bytes
# (oracle._build_llm_request / reduce._build_reduce_request /
# media_intelligence._build_llm_request); per-candidate render lines stay
# caller-owned and are copied here verbatim.


def test_request_golden_reproduction_oracle():
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

    request = build_synthesis_request(
        provider="anthropic",
        system_prompt=_ORACLE_EXPECTED_PROMPT,
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=f"QUESTION: {question.strip()}",
        model_name="claude-haiku-4-5-20251001",
        max_tokens=2000,
    )

    assert request == ModelCall(
        model=ModelRef(provider="anthropic", model="claude-haiku-4-5-20251001"),
        messages=[
            ModelMessage(role="system", content=_ORACLE_EXPECTED_PROMPT, cache_ttl="5m"),
            ModelMessage(
                role="user",
                content=(
                    f"CANDIDATES:\n{rendered}\n\n"
                    f"QUESTION: {question.strip()}\n\n"
                    "Respond with the strict JSON object as instructed."
                ),
                cache_ttl="none",
            ),
        ],
        max_output_tokens=2000,
        reasoning=ReasoningConfig(effort="none"),
    )


def test_request_golden_reproduction_li_reduce():
    candidates = [
        (0, "media-1", "A summary.", "A claim."),
        (1, "media-2", "Another summary.", "Another claim."),
    ]
    rendered = "\n\n".join(
        f"[{global_index}] (media {media_id})\nsummary: {summary_md}\nclaim: {claim_text}"
        for global_index, media_id, summary_md, claim_text in candidates
    )

    request = build_synthesis_request(
        provider="anthropic",
        system_prompt=_LI_EXPECTED_PROMPT,
        candidates_header="UNIT CLAIMS",
        rendered_candidates=rendered,
        extra_user_block=None,
        model_name="claude-sonnet-4-6",
        max_tokens=4000,
    )

    assert request == ModelCall(
        model=ModelRef(provider="anthropic", model="claude-sonnet-4-6"),
        messages=[
            ModelMessage(role="system", content=_LI_EXPECTED_PROMPT, cache_ttl="5m"),
            ModelMessage(
                role="user",
                content=(
                    f"UNIT CLAIMS:\n{rendered}\n\n"
                    "Respond with the strict JSON object as instructed."
                ),
                cache_ttl="none",
            ),
        ],
        max_output_tokens=4000,
        reasoning=ReasoningConfig(effort="none"),
    )


def test_request_golden_reproduction_media_unit():
    texts = ["First passage text.", "Second passage text."]
    rendered = "\n\n".join(f"[{index}] {text}" for index, text in enumerate(texts))

    request = build_synthesis_request(
        provider="anthropic",
        system_prompt=_MEDIA_UNIT_EXPECTED_PROMPT,
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=None,
        model_name="claude-haiku-4-5-20251001",
        max_tokens=2000,
    )

    assert request == ModelCall(
        model=ModelRef(provider="anthropic", model="claude-haiku-4-5-20251001"),
        messages=[
            ModelMessage(role="system", content=_MEDIA_UNIT_EXPECTED_PROMPT, cache_ttl="5m"),
            ModelMessage(
                role="user",
                content=(
                    f"CANDIDATES:\n{rendered}\n\nRespond with the strict JSON object as instructed."
                ),
                cache_ttl="none",
            ),
        ],
        max_output_tokens=2000,
        reasoning=ReasoningConfig(effort="none"),
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


# ---------- runner: success / parse / provider-error --------------------------


async def test_valid_json_validates_into_schema_and_surfaces_usage():
    usage = TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15)
    router = _FakeRouter(
        _response(
            json.dumps({"title": "Folio", "count": 3}),
            usage=usage,
            request_id="req-123",
        )
    )

    result = await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert router.calls == 1, "first-attempt success makes exactly one generate call"
    assert result.value == _Output(title="Folio", count=3)
    assert result.usage is usage, "usage must be surfaced from the response"


async def test_passing_validate_hook_does_not_retry():
    router = _FakeRouter(_response(json.dumps({"title": "Folio", "count": 3})))

    await run_structured_synthesis(
        llm=router, request=_request(), schema=_Output, validate=lambda value: None
    )

    assert router.calls == 1


async def test_leading_and_trailing_whitespace_is_tolerated():
    router = _FakeRouter(_response('\n  {"title": "Folio", "count": 1}\n  '))

    result = await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert result.value == _Output(title="Folio", count=1)


async def test_fenced_json_is_rejected_as_typed_error():
    # The contract is a *bare* JSON object; a ```json fence is rejected (it does
    # not start with "{"), mirroring Oracle's strict no-fence acceptance.
    fenced = "```json\n" + json.dumps({"title": "Folio", "count": 3}) + "\n```"
    router = _FakeRouter(_response(fenced))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_unparseable_json_raises_typed_error():
    router = _FakeRouter(_response("{not valid json,,,}"))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_non_object_json_raises_typed_error():
    # A bare array starts with "[" so it fails the bare-object guard.
    router = _FakeRouter(_response("[1, 2, 3]"))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_schema_mismatch_raises_typed_error():
    # Wrong field type (count is a string) fails strict schema validation.
    router = _FakeRouter(_response(json.dumps({"title": "Folio", "count": "three"})))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_extra_keys_raise_typed_error_under_forbid():
    router = _FakeRouter(_response(json.dumps({"title": "Folio", "count": 3, "extra": "nope"})))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_provider_error_propagates_unchanged_without_repair():
    # The provider-call failure must NOT be wrapped — callers (Oracle) map each
    # ModelCallErrorCode to a distinct domain error code — and must not be repaired.
    error = ModelCallError(ModelCallErrorCode.PROVIDER_DOWN, "boom", provider="anthropic")
    router = _RaisingRouter(error)

    with pytest.raises(ModelCallError) as excinfo:
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert excinfo.value.error_code is ModelCallErrorCode.PROVIDER_DOWN
    assert router.calls == 1, "provider errors are never repaired"


# ---------- runner: the one bounded repair round -------------------------------


async def test_parse_failure_repairs_once_with_appended_turns_and_summed_usage():
    bad = "{not valid json,,,}"
    first_usage = TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15)
    second_usage = TokenUsage(
        input_tokens=20, output_tokens=7, total_tokens=27, cache_read_input_tokens=9
    )
    router = _ScriptedRouter(
        [
            _response(bad, usage=first_usage),
            _response(json.dumps({"title": "Folio", "count": 3}), usage=second_usage),
        ]
    )
    request = _request()

    result = await run_structured_synthesis(llm=router, request=request, schema=_Output)

    assert len(router.requests) == 2
    assert router.requests[0] == request.llm_request
    assert router.requests[1] == replace(
        request.llm_request,
        messages=[
            *request.llm_request.messages,
            *_repair_turns(bad, "response is not valid JSON"),
        ],
    )
    assert result.value == _Output(title="Folio", count=3)
    assert result.usage == TokenUsage(
        input_tokens=30, output_tokens=12, total_tokens=42, cache_read_input_tokens=9
    )


async def test_validate_rejection_repairs_once_with_the_reason():
    draft = json.dumps({"title": "draft", "count": 1})
    router = _ScriptedRouter(
        [
            _response(draft),
            _response(json.dumps({"title": "final", "count": 2})),
        ]
    )

    def validate(value: _Output) -> str | None:
        return "title must not be draft" if value.title == "draft" else None

    result = await run_structured_synthesis(
        llm=router, request=_request(), schema=_Output, validate=validate
    )

    assert len(router.requests) == 2
    assert list(router.requests[1].messages[-2:]) == _repair_turns(draft, "title must not be draft")
    assert result.value == _Output(title="final", count=2)


async def test_second_parse_failure_raises_after_exactly_two_calls():
    router = _FakeRouter(_response("{not valid json,,,}"))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert router.calls == 2, "exactly one repair round; the second failure raises"


async def test_second_validate_rejection_raises_the_reason():
    router = _FakeRouter(_response(json.dumps({"title": "draft", "count": 1})))

    with pytest.raises(StructuredSynthesisError, match="title must not be draft"):
        await run_structured_synthesis(
            llm=router,
            request=_request(),
            schema=_Output,
            validate=lambda value: "title must not be draft",
        )

    assert router.calls == 2


async def test_provider_error_on_the_repair_attempt_propagates_unchanged():
    error = ModelCallError(ModelCallErrorCode.PROVIDER_DOWN, "boom", provider="anthropic")
    router = _ScriptedRouter([_response("not json at all"), error])

    with pytest.raises(ModelCallError) as excinfo:
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert excinfo.value.error_code is ModelCallErrorCode.PROVIDER_DOWN
    assert len(router.requests) == 2


async def test_repair_usage_sum_tolerates_a_missing_attempt_usage():
    second_usage = TokenUsage(input_tokens=8, output_tokens=2, total_tokens=10)
    router = _ScriptedRouter(
        [
            _response("not json at all"),  # usage=None
            _response(json.dumps({"title": "Folio", "count": 3}), usage=second_usage),
        ]
    )

    result = await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert result.usage == second_usage
