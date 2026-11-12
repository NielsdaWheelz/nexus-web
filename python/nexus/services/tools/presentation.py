"""Observed tool activity, shared by saved reads and stage-specific stream reads.

A librarian receipt keeps only target identities: the uri and url arguments and result
values ``services.tools.run`` retains, a memory save's receipt id, status and failure
type. Queries, bodies, cursors, counts and titles are never stored, so nothing here
reads them. A subject is the target's current label; a refused call recorded no input.
Resource hydration is the caller's one batch, and a start stage supplies no result.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

from nexus.schemas.assistant_writes import CreatedRefOut
from nexus.schemas.chat import (
    ActivityTargetOut,
    ExternalActivityTargetOut,
    ResourceActivityTargetOut,
    ToolActivityOut,
    ToolProjectionOut,
)
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_items.items import excerpt
from nexus.services.tools import contract, reads

_ERRORS = {
    "BudgetExceeded": "tool budget exceeded",
    "Conflict": "conflicting change",
    "DeadlineExceeded": "time limit reached",
    "InvalidCursor": "continuation was not accepted",
    "InvalidInput": "input was not accepted",
    "InvalidUpstreamResponse": "provider returned an invalid response",
    "InvalidUrl": "url was not accepted",
    "MemoryFailure": "memory service could not confirm the request",
    "QuoteAmbiguous": "quote matches more than one location",
    "QuoteNotFound": "quote not found",
    "RateLimited": "rate limit reached",
    "ResourceUnavailable": "resource unavailable",
    "StaleCursor": "source changed during continuation",
    "TargetAmbiguous": "destination is ambiguous",
    "TooLarge": "resource exceeds the read limit",
    "ToolUnavailable": "tool unavailable",
    "Uninspectable": "document structure unavailable",
    "Unreadable": "resource cannot be read",
    "UnsafeDestination": "destination was refused",
    "UnsupportedContent": "content type is unsupported",
    "UpstreamUnavailable": "provider unavailable",
    "WriteCapReached": "write limit reached",
}


def _text(value: Mapping[str, Any], key: str) -> str | None:
    found = value.get(key)
    return found if isinstance(found, str) and found else None


def _bounded(value: str | None, limit: int) -> str | None:
    if value is None or len(value) <= limit:
        return value
    return excerpt(value, limit - 1).text + "…"


def _success(result: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return result["value"] if result is not None and result["type"] == "Success" else {}


def _ref(uri: str | None) -> ResourceRef | None:
    if uri is None:
        return None
    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRef):
        return parsed
    pages = reads.parse_page_range(uri)
    return ResourceRef("media", pages[0]) if pages is not None else None


def references(arguments: object, result: Mapping[str, Any] | None) -> list[ResourceRef]:
    """Canonical subjects/destinations to hydrate, never opaque provider identities."""

    args = arguments if isinstance(arguments, dict) else {}
    refs: dict[str, ResourceRef] = {}
    for value in (args, _success(result)):
        for key in (
            "uri",
            "resource_uri",
            "media_uri",
            "source_uri",
            "target_uri",
            "page_uri",
            "note_uri",
            "highlight_uri",
            "library_uri",
        ):
            if (ref := _ref(_text(value, key))) is not None:
                refs[ref.uri] = ref
        if (library_id := _text(value, "library_id")) is not None:
            if (ref := _ref(f"library:{library_id}")) is not None:
                refs[ref.uri] = ref
    return list(refs.values())


def _resource(
    uri: str | None, items: Mapping[str, ResourceItemOut]
) -> tuple[str | None, ResourceActivityTargetOut | None]:
    ref = _ref(uri)
    if ref is None:
        return uri, None
    item = items[ref.uri]
    return (uri if item.missing else item.label), ResourceActivityTargetOut(item=item)


def _named(uri: str | None, items: Mapping[str, ResourceItemOut]) -> str | None:
    label, _ = _resource(uri, items)
    return f"{_bounded(label, 160)} ({uri})" if label and label != uri else uri


def _external(url: str | None) -> ExternalActivityTargetOut | None:
    if url is None or len(url) > 4096 or any(ord(char) < 32 for char in url):
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username:
            return None
        _ = parsed.port  # malformed ports are not navigable urls
    except ValueError:
        return None
    return ExternalActivityTargetOut(href=url)


def created_refs(refs: Sequence[dict[str, Any]]) -> list[CreatedRefOut]:
    """Bound chat copy without changing the durable write or its undo receipt."""

    return [
        CreatedRefOut.model_validate({**ref, "label": _bounded(ref["label"], 160)}) for ref in refs
    ]


def project(
    tool_id: str,
    *,
    arguments: object,
    result: Mapping[str, Any] | None,
    status: str,
    items: Mapping[str, ResourceItemOut],
) -> ToolProjectionOut:
    """Project the supplied stage only; callers never pass a future result to start."""

    result_kind, verb = contract.PRESENTATION[tool_id]
    args = arguments if isinstance(arguments, dict) else {}
    value = _success(result)
    subject: str | None = None
    target: ActivityTargetOut | None = None
    detail: list[str] = []
    outcome: str | None = None

    match tool_id:
        case "web.read":
            subject = _text(args, "url")
            target = _external(subject)
        case (
            "nexus.resource.read"
            | "nexus.document.search"
            | "nexus.resource.inspect"
            | "nexus.relations.list"
        ):
            uri = _text(args, "uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if uri and (pages := reads.parse_page_range(uri)) is not None:
                detail.append(f"pages {pages[1]}–{pages[2]}")
        case "nexus.library.add":
            uri = _text(args, "resource_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            library_id = _text(args, "library_id")
            library = _named(
                f"library:{library_id}" if library_id else _text(value, "library_uri"), items
            )
            if library:
                detail.append(f"library: {library}")
        case "nexus.note.create":
            subject, target = _resource(_text(value, "note_uri"), items)
            if page := _named(_text(args, "page_uri"), items):
                detail.append(f"page: {page}")
            elif "page_uri" in args and args["page_uri"] is None:
                detail.append("daily note")
        case "nexus.highlight.create" | "nexus.queue.add":
            uri = _text(args, "media_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
        case "nexus.edge.create":
            uri = _text(args, "source_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if destination := _named(_text(args, "target_uri"), items):
                detail.append(f"to: {destination}")
        case "memory.save_note":
            if receipt := _text(value, "id"):
                detail.append(f"receipt: {receipt}")
                outcome = "saved"
        case (
            "web.search"
            | "nexus.search"
            | "memory.search"
            | "memory.open"
            | "memory.view"
            | "memory.zoom"
            | "memory.date"
        ):
            pass  # these name no retained target: verb, status and failure are the receipt
        case _:
            raise AssertionError(f"unprojected tool: {tool_id}")

    if arguments is None:
        detail.append("input not recorded")
    error = result["error"]["type"] if result is not None and result["type"] == "Failure" else None
    if error is not None:
        outcome = _ERRORS[error]
    elif result is None and status != "running":
        outcome = "no result recorded"
    if (
        tool_id == "memory.save_note"
        and status != "running"
        and not _text(value, "id")
        and error not in ("InvalidInput", "BudgetExceeded", "ToolUnavailable")
    ):
        if error is not None:
            detail.append(_ERRORS[error])
        outcome = "save not confirmed"
    return ToolProjectionOut(
        canonical_tool_id=tool_id,
        effect=contract.SPECS[tool_id].effect,
        result_kind=result_kind,
        error_type=error,
        activity=ToolActivityOut(
            verb=verb,
            subject=_bounded(subject, 2048),
            target=target,
            detail=_bounded("\n".join(detail), 2000) if detail else None,
            outcome=_bounded(outcome, 160),
        ),
    )
