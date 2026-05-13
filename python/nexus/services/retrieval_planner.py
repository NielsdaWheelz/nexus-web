"""Structured retrieval planning for chat context assembly."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from llm_calling.types import Turn

from nexus.errors import ApiError, ApiErrorCode

APP_SEARCH_QUERY_MAX_CHARS = 512
APP_SEARCH_TYPES_ALL = ("media", "podcast", "content_chunk", "contributor", "note_block", "message")
APP_SEARCH_TYPES_SCOPED = ("content_chunk",)

_SHORT_NON_SEARCH_MESSAGES = {
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
}

_APP_SEARCH_CUE_TERMS = (
    "find",
    "search",
    "look up",
    "lookup",
    "show me",
    "source",
    "sources",
    "cite",
    "citation",
    "saved",
    "library",
    "highlight",
    "note",
    "notes",
    "fragment",
    "episode",
    "podcast",
    "video",
    "article",
    "book",
    "pdf",
    "document",
    "transcript",
    "where did",
    "what did",
    "when did",
    "summarize",
    "compare",
)

_WEB_SEARCH_CUE_TERMS = (
    "latest",
    "current",
    "today",
    "yesterday",
    "tomorrow",
    "recent",
    "news",
    "price",
    "pricing",
    "release",
    "changelog",
    "docs",
    "documentation",
    "source",
    "sources",
    "cite",
    "citation",
    "verify",
    "look up",
    "lookup",
    "web",
    "internet",
    "search the web",
    "find online",
    "api",
    "law",
    "legal",
    "regulation",
    "standard",
)


@dataclass(frozen=True)
class AppSearchPlan:
    enabled: bool
    query: str | None
    scope: str
    types: tuple[str, ...]
    semantic: bool
    filters: Mapping[str, object]
    reason: str


@dataclass(frozen=True)
class WebSearchPlan:
    enabled: bool
    reason: str


@dataclass(frozen=True)
class ContextLookupRequest:
    source_ref: Mapping[str, object]
    purpose: str


@dataclass(frozen=True)
class RetrievalPlan:
    app_search: AppSearchPlan
    web_search: WebSearchPlan
    context_lookup: tuple[ContextLookupRequest, ...]


def build_retrieval_plan(
    *,
    user_content: str,
    history: Sequence[Turn],
    scope_metadata: Mapping[str, object],
    attached_context_refs: Sequence[Mapping[str, object]] = (),
    memory_source_refs: Sequence[Mapping[str, object]] = (),
    web_search_options: Mapping[str, object] | None = None,
) -> RetrievalPlan:
    """Build a structured plan without executing retrieval or answering the user."""

    app_scope = app_search_scope_for_conversation(scope_metadata)
    scope_type = str(scope_metadata.get("type") or "general")
    has_user_context = bool(attached_context_refs)
    app_filters = _app_search_filters_for_context(scope_metadata, attached_context_refs)
    normalized = " ".join(user_content.lower().split())
    app_enabled = _should_run_app_search(
        normalized,
        has_user_context=has_user_context,
        scoped=scope_type in {"media", "library"},
    )
    app_reason = "scoped conversation" if scope_type in {"media", "library"} else "query cues"
    if not app_enabled:
        app_reason = "no app-search cues"

    app_search = AppSearchPlan(
        enabled=app_enabled,
        query=build_app_search_query(
            user_content,
            history=history,
            scope_metadata=scope_metadata,
            attached_context_refs=attached_context_refs,
            memory_source_refs=memory_source_refs,
        )
        if app_enabled
        else None,
        scope=app_scope,
        types=APP_SEARCH_TYPES_SCOPED
        if scope_type in {"media", "library"}
        else APP_SEARCH_TYPES_ALL,
        semantic=True,
        filters=app_filters,
        reason=app_reason,
    )

    web_search = _plan_web_search(normalized, web_search_options or {"mode": "off"})
    context_lookup = tuple(
        ContextLookupRequest(source_ref=source_ref, purpose="hydrate memory source evidence")
        for source_ref in _dedupe_source_refs(memory_source_refs)
    )
    return RetrievalPlan(
        app_search=app_search,
        web_search=web_search,
        context_lookup=context_lookup,
    )


def app_search_scope_for_conversation(scope_metadata: Mapping[str, object]) -> str:
    """Return the app-search scope implied by persisted conversation scope."""

    scope_type = scope_metadata.get("type")
    if scope_type == "general":
        return "all"
    if scope_type == "media":
        media_id = scope_metadata.get("media_id")
        if not isinstance(media_id, str) or not media_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid media conversation scope")
        return f"media:{media_id}"
    if scope_type == "library":
        library_id = scope_metadata.get("library_id")
        if not isinstance(library_id, str) or not library_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid library conversation scope")
        return f"library:{library_id}"
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def _app_search_filters_for_context(
    scope_metadata: Mapping[str, object],
    attached_context_refs: Sequence[Mapping[str, object]],
) -> Mapping[str, object]:
    contributor_handles: list[str] = []
    roles: list[str] = []
    content_kinds: list[str] = []

    for ref in attached_context_refs:
        if ref.get("type") != "contributor":
            continue
        handle = _contributor_handle_from_ref(ref)
        if handle:
            contributor_handles.append(handle)

    for key, target in (("roles", roles), ("content_kinds", content_kinds)):
        raw_values = scope_metadata.get(key)
        if isinstance(raw_values, str):
            values = [raw_values]
        elif isinstance(raw_values, Sequence):
            values = list(raw_values)
        else:
            values = []
        seen_values: set[str] = set()
        for raw_value in values:
            value = str(raw_value or "").strip()
            if not value or value in seen_values:
                continue
            target.append(value)
            seen_values.add(value)

    seen_handles: set[str] = set()
    deduped_handles: list[str] = []
    for handle in contributor_handles:
        if handle in seen_handles:
            continue
        deduped_handles.append(handle)
        seen_handles.add(handle)

    return {
        "contributor_handles": deduped_handles,
        "roles": roles,
        "content_kinds": content_kinds,
    }


def build_app_search_query(
    content: str,
    *,
    history: Sequence[Turn],
    scope_metadata: Mapping[str, object],
    attached_context_refs: Sequence[Mapping[str, object]] = (),
    memory_source_refs: Sequence[Mapping[str, object]] = (),
) -> str:
    """Rewrite the current user turn into a bounded standalone retrieval query."""

    query = " ".join(content.split()).strip()
    lowered = query.lower()
    for prefix in (
        "find me ",
        "find ",
        "search for ",
        "search ",
        "look up ",
        "lookup ",
        "show me ",
        "show ",
        "sources for ",
        "cite ",
        "what did ",
        "where did ",
        "when did ",
    ):
        if lowered.startswith(prefix):
            query = query[len(prefix) :].strip()
            lowered = query.lower()
            break

    for phrase in (
        " in my library",
        " from my library",
        " in my saved items",
        " from my saved items",
        " in saved content",
        " from saved content",
    ):
        query = query.replace(phrase, "").replace(phrase.title(), "")

    query = query.strip(" \t\r\n?.!,;:")
    normalized = " ".join(query.lower().split())
    if normalized in {"what about that", "what about it", "tell me more", "why"}:
        prior_user = _latest_prior_user_text(history)
        if prior_user:
            query = f"{prior_user} {query}"

    scope_title = scope_metadata.get("title")
    if scope_metadata.get("type") in {"media", "library"} and isinstance(scope_title, str):
        if scope_title and scope_title.lower() not in query.lower():
            query = f"{scope_title} {query}"

    source_labels = _source_ref_labels(memory_source_refs)
    if source_labels:
        query = f"{query} {' '.join(source_labels)}".strip()

    reader_selection_terms = _reader_selection_query_terms(attached_context_refs)
    if reader_selection_terms:
        query = f"{' '.join(reader_selection_terms)} {query}".strip()

    return (query or content).strip()[:APP_SEARCH_QUERY_MAX_CHARS]


def _reader_selection_query_terms(refs: Sequence[Mapping[str, object]]) -> list[str]:
    terms: list[str] = []
    for ref in refs:
        if ref.get("kind") != "reader_selection":
            continue
        media_title = _compact_text(ref.get("media_title") or ref.get("mediaTitle"))
        exact = _compact_text(ref.get("exact"))
        if media_title:
            terms.append(media_title[:120])
        if exact:
            terms.append(exact[:240])
        if len(terms) >= 4:
            break
    return terms


def _compact_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split()).strip()
    return text or None


def _latest_prior_user_text(history: Sequence[Turn]) -> str | None:
    for turn in reversed(history):
        if turn.role == "user" and turn.content.strip():
            return turn.content.strip()
    return None


def _should_run_app_search(
    normalized_content: str, *, has_user_context: bool, scoped: bool
) -> bool:
    if scoped:
        return True
    if len(normalized_content) < 2 or normalized_content in _SHORT_NON_SEARCH_MESSAGES:
        return False
    if any(term in normalized_content for term in _APP_SEARCH_CUE_TERMS):
        return True
    return not has_user_context and len(normalized_content) >= 12


def _plan_web_search(
    normalized_content: str,
    options: Mapping[str, object],
) -> WebSearchPlan:
    mode = options.get("mode")
    if mode == "off":
        return WebSearchPlan(enabled=False, reason="web search disabled")
    if mode == "required":
        return WebSearchPlan(enabled=True, reason="web search required")
    if mode == "auto":
        enabled = (
            len(normalized_content) >= 2
            and normalized_content not in _SHORT_NON_SEARCH_MESSAGES
            and any(term in normalized_content for term in _WEB_SEARCH_CUE_TERMS)
        )
        return WebSearchPlan(
            enabled=enabled,
            reason="web-search cues" if enabled else "no web-search cues",
        )
    return WebSearchPlan(enabled=False, reason="web search disabled")


def _source_ref_labels(source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    labels: list[str] = []
    for source_ref in source_refs[:4]:
        label = source_ref.get("label") or source_ref.get("title")
        if isinstance(label, str) and label.strip():
            labels.append(" ".join(label.split())[:80])
    return labels


def _dedupe_source_refs(
    source_refs: Sequence[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    seen: set[tuple[str, str]] = set()
    deduped: list[Mapping[str, object]] = []
    for source_ref in source_refs:
        ref_type = source_ref.get("type")
        ref_id = _source_ref_identity(source_ref)
        if not isinstance(ref_type, str) or not ref_id:
            continue
        key = (ref_type, ref_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(source_ref)
    return deduped


def _source_ref_identity(source_ref: Mapping[str, object]) -> str | None:
    for key in ("id", "message_id", "message_context_id", "retrieval_id", "result_ref"):
        value = source_ref.get(key)
        if isinstance(value, str) and value:
            return value
    context_ref = source_ref.get("context_ref")
    if isinstance(context_ref, Mapping):
        ref_type = context_ref.get("type")
        ref_id = (
            _contributor_handle_from_ref(context_ref)
            if ref_type == "contributor"
            else context_ref.get("id")
        )
        if isinstance(ref_type, str) and isinstance(ref_id, str):
            return f"{ref_type}:{ref_id}"
    return None


def _contributor_handle_from_ref(ref: Mapping[str, object]) -> str | None:
    for key in ("contributor_handle", "handle"):
        value = ref.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    value = ref.get("id")
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        UUID(text)
    except ValueError:
        return text
    return None
