"""Internal ranked results, their row builders, and the cross-type ranking."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID

from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import presence_from_nullable
from nexus.schemas.search import SearchResultSourceOut
from nexus.services.resource_graph.refs import ResourceRef

# Post-normalization multipliers; also the weights of the target-only candidate
# types built in ``candidates.py``.
TYPE_WEIGHTS = {
    "media": 1.3,
    "podcast": 1.15,
    "episode": 1.15,
    "video": 1.15,
    "content_chunk": 1.1,
    "fragment": 1.1,
    "contributor": 1.25,
    "page": 1.2,
    "note_block": 1.2,
    "highlight": 1.25,
    "message": 1.0,
    "reader_apparatus_item": 1.1,
    "conversation": 0.95,
    "artifact": 0.95,
    "web_result": 0.9,
    "library": 1.2,
    "oracle_reading": 1.0,
    "passage_anchor": 1.25,
}
MAX_TYPE_WEIGHT = max(TYPE_WEIGHTS.values())


@dataclass(slots=True)
class _SearchScore:
    raw: float
    normalized: float = 0.0


@dataclass(slots=True)
class _RankedMediaResult:
    id: UUID
    snippet: str
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["media", "episode", "video"] = "media"


@dataclass(slots=True)
class _RankedPodcastResult:
    id: UUID
    title: str
    contributors: list[ContributorCreditOut]
    snippet: str
    score: _SearchScore
    result_type: Literal["podcast"] = "podcast"


@dataclass(slots=True)
class _RankedNoteBlockResult:
    id: UUID
    snippet: str
    body_text: str
    score: _SearchScore
    highlight_excerpt: str | None = None
    note_origin: Literal["note", "highlight_note"] = "note"
    locator: dict[str, Any] | None = None
    result_type: Literal["note_block"] = "note_block"


@dataclass(slots=True)
class _RankedHighlightResult:
    id: UUID
    snippet: str
    exact: str
    color: str
    source: SearchResultSourceOut
    score: _SearchScore
    citation_label: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["highlight"] = "highlight"


@dataclass(slots=True)
class _RankedPageResult:
    id: UUID
    title: str
    snippet: str
    score: _SearchScore
    result_type: Literal["page"] = "page"


@dataclass(slots=True)
class _RankedMessageResult:
    id: UUID
    snippet: str
    conversation_id: UUID
    seq: int
    score: _SearchScore
    locator: dict[str, Any] | None = None
    result_type: Literal["message"] = "message"


@dataclass(slots=True)
class _RankedContentChunkResult:
    id: UUID
    snippet: str
    source_kind: str
    evidence_span_ids: list[UUID]
    citation_label: str
    locator: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["content_chunk"] = "content_chunk"


@dataclass(slots=True)
class _RankedEvidenceSpanResult:
    """Reopen-only: `evidence_span:` citations re-materialize through this row.

    ``owner_ref`` is explicit because a note-owned span's ``source.media_id``
    holds its note_block id, so the owner cannot be inferred by scheme.
    """

    id: UUID
    snippet: str
    citation_label: str
    locator: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    owner_ref: ResourceRef
    result_type: Literal["evidence_span"] = "evidence_span"


@dataclass(slots=True)
class _RankedReaderApparatusItemResult:
    id: UUID
    snippet: str
    apparatus_kind: str
    locator: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["reader_apparatus_item"] = "reader_apparatus_item"


@dataclass(slots=True)
class _RankedFragmentResult:
    id: UUID
    idx: int
    query: str | None
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["fragment"] = "fragment"


@dataclass(slots=True)
class _RankedContributorResult:
    id: UUID
    handle: str
    display_name: str
    snippet: str
    score: _SearchScore
    result_type: Literal["contributor"] = "contributor"


@dataclass(slots=True)
class _RankedConversationResult:
    id: UUID
    title: str
    snippet: str
    score: _SearchScore
    result_type: Literal["conversation"] = "conversation"


@dataclass(slots=True)
class _RankedArtifactResult:
    id: UUID  # the conversation id (subject)
    revision_id: UUID
    snippet: str
    score: _SearchScore
    result_type: Literal["artifact"] = "artifact"


@dataclass(slots=True)
class _RankedWebResult:
    id: str
    source_id: str
    result_ref: str
    title: str
    url: str
    display_url: str | None
    extra_snippets: list[str]
    published_at: str | None
    source_name: str | None
    rank: int | None
    provider: str | None
    provider_request_id: str | None
    snippet: str
    locator: dict[str, Any]
    selected: bool
    score: _SearchScore
    result_type: Literal["web_result"] = "web_result"


InternalSearchResult = (
    _RankedMediaResult
    | _RankedPodcastResult
    | _RankedContentChunkResult
    | _RankedEvidenceSpanResult
    | _RankedFragmentResult
    | _RankedContributorResult
    | _RankedPageResult
    | _RankedNoteBlockResult
    | _RankedHighlightResult
    | _RankedMessageResult
    | _RankedReaderApparatusItemResult
    | _RankedConversationResult
    | _RankedArtifactResult
    | _RankedWebResult
)


def _build_search_score(raw_score: Any) -> _SearchScore:
    return _SearchScore(raw=float(raw_score) if raw_score else 0.0)


def _parse_contributor_credits(value: Any) -> list[ContributorCreditOut]:
    if not value:
        return []
    return [ContributorCreditOut.model_validate(item) for item in list(value)]


def _build_search_source(
    media_id: UUID,
    media_kind: str,
    title: str,
    contributors: Any,
    original_published_date: Any,
) -> SearchResultSourceOut:
    return SearchResultSourceOut(
        media_id=media_id,
        media_kind=media_kind,
        title=title,
        contributors=_parse_contributor_credits(contributors),
        original_published_date=presence_from_nullable(original_published_date),
    )


def _credited_names(contributors: list[ContributorCreditOut]) -> list[str]:
    return [credit.credited_name for credit in contributors if credit.credited_name]


class _Scored(Protocol):
    """Any ranked candidate: a public result or a target-only candidate."""

    score: _SearchScore

    @property
    def result_type(self) -> str: ...

    @property
    def id(self) -> UUID | str: ...


def rank_candidates[C: _Scored](candidates: list[C]) -> list[C]:
    """Normalize within type, weight, project to [0, 1], sort deterministically."""
    by_type: dict[str, list[C]] = {}
    for candidate in candidates:
        by_type.setdefault(candidate.result_type, []).append(candidate)
    for group in by_type.values():
        highest = max(candidate.score.raw for candidate in group)
        lowest = min(candidate.score.raw for candidate in group)
        for candidate in group:
            if highest == lowest:
                candidate.score.normalized = 1.0 if highest > 0 else 0.5
            else:
                candidate.score.normalized = (candidate.score.raw - lowest) / (highest - lowest)
    for candidate in candidates:
        weight = TYPE_WEIGHTS[candidate.result_type]
        candidate.score.normalized = candidate.score.normalized * weight / MAX_TYPE_WEIGHT
    candidates.sort(key=_rank_key)
    return candidates


def _rank_key(candidate: _Scored) -> tuple[float, str]:
    identity = (
        candidate.handle if isinstance(candidate, _RankedContributorResult) else str(candidate.id)
    )
    return (-candidate.score.normalized, identity)
