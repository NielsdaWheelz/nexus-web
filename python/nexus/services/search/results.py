"""Internal ranked-result dataclasses, the InternalSearchResult union, and row builders."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from nexus.schemas.contributors import ContributorCreditOut, ContributorOut
from nexus.schemas.retrieval import retrieval_result_ref_json
from nexus.schemas.search import SearchResultSourceOut


@dataclass(slots=True)
class _SearchScore:
    raw: float
    weighted: float = 0.0
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
    resolver: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["content_chunk"] = "content_chunk"


@dataclass(slots=True)
class _RankedEvidenceSpanResult:
    id: UUID
    snippet: str
    citation_label: str
    locator: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
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
    snippet: str
    source: SearchResultSourceOut
    score: _SearchScore
    citation_label: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["fragment"] = "fragment"


@dataclass(slots=True)
class _RankedContributorResult:
    id: UUID
    handle: str
    contributor: ContributorOut
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


def _web_result_ref_json(raw_result_ref: Any) -> dict[str, Any]:
    if not isinstance(raw_result_ref, dict):
        raise ValueError("web_result result_ref must be a JSON object")
    return retrieval_result_ref_json(raw_result_ref)


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
    | _RankedWebResult
)


def _build_search_score(raw_score: Any) -> _SearchScore:
    return _SearchScore(raw=float(raw_score) if raw_score else 0.0)


def _build_search_source(
    media_id: UUID,
    media_kind: str,
    title: str,
    contributors: Any,
    published_date: Any,
) -> SearchResultSourceOut:
    parsed_contributors = _parse_contributor_credits(contributors)
    return SearchResultSourceOut(
        media_id=media_id,
        media_kind=media_kind,
        title=title,
        contributors=parsed_contributors,
        published_date=str(published_date) if published_date is not None else None,
    )


def _parse_contributor_credits(value: Any) -> list[ContributorCreditOut]:
    if not value:
        return []
    return [ContributorCreditOut.model_validate(item) for item in list(value)]


def _parse_contributor(value: Any) -> ContributorOut:
    return ContributorOut.model_validate(dict(value or {}))


def _credited_names(contributors: list[ContributorCreditOut]) -> list[str]:
    names: list[str] = []
    for credit in contributors:
        credited_name = getattr(credit, "credited_name", None)
        if isinstance(credited_name, str) and credited_name:
            names.append(credited_name)
            continue
        contributor = getattr(credit, "contributor", None)
        display_name = getattr(contributor, "display_name", None)
        if isinstance(display_name, str) and display_name:
            names.append(display_name)
    return names
