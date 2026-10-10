"""The oracle's llm contract: the snapshot (the generation input, canonical JSON), the
prompt, and the outcome; any broken reading rule is ``invalid_output``, no repair."""

import re
from typing import Literal, cast

from llm_tools import canonical_json_bytes
from pydantic import BaseModel, ConfigDict

from nexus.schemas.oracle import OracleFailureCode, OraclePhase, OracleSourceKind
from nexus.services.generation.contract import (
    Cancelled,
    GenerationIntent,
    InvalidOutput,
    Succeeded,
    Terminal,
)
from nexus.services.generation.synthesis import (
    INDEX_GROUNDING_RULE,
    build_synthesis_intent,
    build_synthesis_prompt,
)

PHASES: tuple[OraclePhase, OraclePhase, OraclePhase] = ("descent", "ordeal", "ascent")
# Mirrors the ck_oracle_readings_theme CHECK.
THEMES: tuple[str, ...] = (
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


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Candidate(_Frozen):
    """One passage offered to the model by index; ``ref`` is its citation target."""

    source_kind: OracleSourceKind
    ref: str
    attribution: str
    locator: str | None
    quote: str
    tags: tuple[str, ...]


class PlateBrief(_Frozen):
    key: str
    artist: str
    work_title: str
    year: str | None


class Snapshot(_Frozen):
    """The whole generation input; the plate is chosen before the model sees the passages."""

    kind: Literal["oracle-input.v2"]
    question: str
    plate: PlateBrief
    candidates: tuple[Candidate, ...]
    requires_user_content: bool


class Chosen(_Frozen):
    phase: OraclePhase
    candidate: Candidate
    marginalia: str


class Success(_Frozen):
    outcome: Literal["success"]
    folio_motto: str
    folio_motto_gloss: str | None
    folio_theme: str
    argument: str
    interpretation: str
    omens: tuple[str, str, str]
    plate_key: str
    passages: tuple[Chosen, Chosen, Chosen]  # descent, ordeal, ascent


class Failure(_Frozen):
    outcome: Literal["failure"]
    error_code: OracleFailureCode
    error_detail: str | None


class _Pick(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    phase: str
    candidate_index: int
    marginalia: str


class Output(BaseModel):
    """The model's strict JSON; ``_violation`` owns every semantic rule."""

    model_config = ConfigDict(strict=True, extra="forbid")

    argument: str
    folio_motto: str
    folio_motto_gloss: str | None
    folio_theme: str
    passages: list[_Pick]
    interpretation: str
    omens: list[str]


def intent(snapshot: Snapshot) -> GenerationIntent:
    return build_synthesis_intent(
        system_prompt=_SYSTEM_PROMPT,
        user_content=canonical_json_bytes(snapshot.model_dump(mode="json")).decode(),
        schema=Output,
    )


def accept(out: Output, snapshot: Snapshot) -> Success:
    """The reading the model's output makes, or ``InvalidOutput`` naming the broken rule."""
    violation = _violation(out, snapshot)
    if violation is not None:
        raise InvalidOutput(violation)
    picks = {pick.phase: pick for pick in out.passages}
    descent, ordeal, ascent = (
        Chosen(
            phase=phase,
            candidate=snapshot.candidates[picks[phase].candidate_index],
            marginalia=picks[phase].marginalia.strip(),
        )
        for phase in PHASES
    )
    first, second, third = (line.strip() for line in out.omens)
    gloss = out.folio_motto_gloss
    return Success(
        outcome="success",
        folio_motto=out.folio_motto.strip(),
        folio_motto_gloss=None if gloss is None else gloss.strip(),
        folio_theme=out.folio_theme,
        argument=out.argument,
        interpretation=out.interpretation.strip(),
        omens=(first, second, third),
        plate_key=snapshot.plate.key,
        passages=(descent, ordeal, ascent),
    )


def outcome(terminal: Terminal[Success]) -> Success | Failure:
    """The reading's outcome; generation codes the reading has no copy for fold in."""
    if isinstance(terminal, Succeeded):
        return terminal.value
    if isinstance(terminal, Cancelled):
        return Failure(outcome="failure", error_code="cancelled", error_detail=None)
    codes: dict[str, OracleFailureCode] = {
        "rate_limited": "runtime_unavailable",
        "content_filtered": "policy_violation",
        "interrupted": "runtime_unavailable",
        "defect": "runtime_unavailable",
    }
    code = codes.get(terminal.code, cast(OracleFailureCode, terminal.code))
    return Failure(outcome="failure", error_code=code, error_detail=terminal.detail)


def _violation(out: Output, snapshot: Snapshot) -> str | None:
    """The first reading rule the output breaks, or None."""
    argument = out.argument
    if not (argument == argument.strip() and 80 <= len(argument) <= 180) or "\n" in argument:
        return "the argument must be one stripped line of 80 to 180 characters"
    if not argument.startswith("Of "):
        return "the argument must begin with 'Of '"
    motto = out.folio_motto.strip()
    if not 1 <= len(motto) <= 80 or "\n" in motto:
        return "the motto must be one line of at most 80 characters"
    gloss = out.folio_motto_gloss
    if gloss is not None and (not 1 <= len(gloss.strip()) <= 120 or "\n" in gloss.strip()):
        return "the gloss must be null or one line of at most 120 characters"
    if out.folio_theme not in THEMES:
        return "the theme must be one of the listed themes"
    if not out.interpretation.strip():
        return "the interpretation is blank"
    if len(out.omens) != 3 or any(not line.strip() for line in out.omens):
        return "there must be exactly three non-blank omens"
    indices = [pick.candidate_index for pick in out.passages]
    if sorted(pick.phase for pick in out.passages) != sorted(PHASES):
        return "there must be exactly one passage per phase"
    if len(set(indices)) != 3 or not all(0 <= i < len(snapshot.candidates) for i in indices):
        return "the three passages must be distinct offered candidates"
    if any(not pick.marginalia.strip() for pick in out.passages):
        return "every passage needs a marginal note"
    chosen = [snapshot.candidates[i] for i in indices]
    if snapshot.requires_user_content and all(c.source_kind != "user_media" for c in chosen):
        return "select at least one source_kind=user_media candidate among the three phases"
    generated = [argument, motto, out.interpretation, *out.omens, gloss or ""]
    generated += [pick.marginalia for pick in out.passages]
    if any(_URL.search(text) or _CITATION_MARKER.search(text) for text in generated):
        return "generated prose may not carry URLs or citation markers"
    if any(_quotes(text, snapshot.candidates) for text in generated):
        return "generated prose may not quote the passages"
    return None


def _quotes(generated: str, candidates: tuple[Candidate, ...]) -> bool:
    """Whether the text repeats a candidate quote: four whole words, 18+ letters. A
    candidate of fewer than four words has no such window and is never matched."""
    joined = f" {' '.join(_words(generated))} "
    for candidate in candidates:
        words = _words(candidate.quote)
        for start in range(len(words) - 3):
            window = words[start : start + 4]
            if len("".join(window)) >= 18 and f" {' '.join(window)} " in joined:
                return True
    return False


def _words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", value.lower())


_URL = re.compile(r"\b(?:https?://|www\.)", re.IGNORECASE)
_CITATION_MARKER = re.compile(
    r"(\[[0-9]+\]"
    r"|\b(?:canto|book|chapter|ch\.|verse|line|lines|page|pages|p\.|pp\.)\s+"
    r"(?:[ivxlcdm]+|\d+)"
    r"|\b[ivxlcdm]{1,8}\.\d+(?:[-–]\d+)?\b"
    r"|\b\d+:\d+(?:[-–]\d+)?\b)",
    re.IGNORECASE,
)

_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=(
        "You are the Black Forest Oracle. You speak in the register of Romantic and "
        "Gothic literature: candle-lit, formal but not stiff, attentive to weight and "
        "shadow. You are not a chatbot, an oracle character, or a fortune teller; you "
        "are an editorial voice arranging public-domain literary fragments and a single "
        "engraved plate into a coherent reading of the asker's question."
    ),
    preamble=(
        "EVERY READING IS A JOURNEY IN THREE PHASES.\n"
        "- DESCENT: the ground falls away; the question's shadow first appears.\n"
        "- ORDEAL: the soul wrestles; the matter at its hardest, its standstill.\n"
        "- ASCENT: the breaking through; what the dawn shows, what is given to see."
    ),
    domain_rules=[
        INDEX_GROUNDING_RULE,
        "The input is JSON. A candidate's index is its zero-based position in candidates.",
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
        + ", ".join(f'"{theme}"' for theme in THEMES)
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
    ],
    json_shape=(
        '{"argument": string, "folio_motto": string, "folio_motto_gloss": string|null, '
        '"folio_theme": string, "passages": '
        '[{"phase": "descent"|"ordeal"|"ascent", "candidate_index": int, '
        '"marginalia": string}], "interpretation": string, "omens": '
        "[string, string, string]}"
    ),
)
