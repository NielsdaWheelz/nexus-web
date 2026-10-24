"""Observed tool activity, shared by saved reads and stage-specific stream reads.

Arguments are recorded input, including refused input; today's provider schema is
not their decoder. Only named primitive facts become public copy. Bodies, cursors
and provider metadata never enter the message projection. Resource hydration is
the caller's one batch, and a start stage supplies no result.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

from nexus.schemas.assistant_writes import CreatedRefOut
from nexus.schemas.conversation import (
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


def _integer(value: Mapping[str, Any], key: str) -> int | None:
    found = value.get(key)
    return found if isinstance(found, int) and not isinstance(found, bool) else None


def _list(value: Mapping[str, Any], key: str) -> list[Any] | None:
    found = value.get(key)
    return found if isinstance(found, list) else None


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
        case "web.search":
            subject = _text(args, "query")
            if (days := _integer(args, "freshness_days")) is not None:
                detail.append(f"past {days} days")
            if _list(value, "results") == []:
                outcome = "no results"
        case "web.read":
            subject = _text(args, "url")
            target = _external(subject)
            if title := _text(value, "title"):
                detail.append(title)
            if (url := _text(value, "final_url")) and url != subject:
                detail.append(f"final url: {url}")
        case "nexus.search":
            subject = _text(args, "query")
            for key in ("kinds", "formats", "authors", "roles", "scopes"):
                selected = _list(args, key)
                if selected or (selected == [] and key in ("kinds", "scopes")):
                    labels = dict.fromkeys(item for item in selected or [] if isinstance(item, str))
                    detail.append(f"{key}: {', '.join(labels) or 'none'}")
            if _list(value, "matches") == []:
                outcome = "no results"
            elif value.get("has_more") is True:
                outcome = "more results available"
        case "nexus.resource.read":
            uri = _text(args, "uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if uri and (pages := reads.parse_page_range(uri)) is not None:
                detail.append(f"pages {pages[1]}–{pages[2]}")
            if _text(args, "cursor"):
                detail.append("continued read")
            if _text(value, "next_cursor"):
                outcome = "more content available"
        case "nexus.document.search":
            subject = _text(args, "query")
            if document := _named(_text(args, "uri"), items):
                detail.append(f"document: {document}")
            if _list(value, "matches") == []:
                outcome = "no matching passages"
        case "nexus.resource.inspect":
            uri = _text(args, "uri")
            subject, target = _resource(uri, items)
            if value:
                resource = contract.ResourceInspectSuccess.model_validate(value).resource
                if isinstance(resource, contract.MediaInspectSuccess):
                    subject = resource.title
                    count = resource.total_sections
                    outcome = f"{count} section{'s' if count != 1 else ''}"
                else:
                    subject = resource.name
            if uri and uri != subject:
                detail.append(uri)
        case "nexus.relations.list":
            uri = _text(args, "uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if direction := _text(args, "direction"):
                detail.append(f"direction: {direction}")
            if (kinds := _list(args, "kinds")) is not None:
                detail.append(
                    f"kinds: {', '.join(k for k in kinds if isinstance(k, str)) or 'none'}"
                )
            if (relations := _list(value, "relations")) is not None:
                count = len(relations)
                outcome = f"{count} connection{'s' if count != 1 else ''}"
        case "nexus.library.add":
            uri = _text(args, "resource_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            library_id = _text(args, "library_id")
            library_uri = f"library:{library_id}" if library_id else _text(value, "library_uri")
            if not library_id and (name := _text(args, "library_name")):
                library = f"{name} ({library_uri})" if library_uri else name
            else:
                library = _named(library_uri, items)
            if library:
                detail.append(f"library: {library}")
            podcast = value.get("podcast")
            if isinstance(podcast, dict):
                operation = podcast.get("import")
                if isinstance(operation, dict):
                    state = _text(operation, "state")
                    outcome = "import " + state if state else "import accepted"
            elif value.get("already_present") is True:
                outcome = "already present"
            elif value.get("already_present") is False:
                outcome = "added"
        case "nexus.note.create":
            subject = _bounded(_text(args, "markdown"), 160)
            page = _named(_text(args, "page_uri"), items)
            if page:
                detail.append(f"page: {page}")
            elif "page_uri" in args and args["page_uri"] is None:
                detail.append("daily note")
            _, target = _resource(_text(value, "note_uri"), items)
        case "nexus.highlight.create":
            uri = _text(args, "media_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if quote := _bounded(_text(args, "exact"), 160):
                detail.append(f"quote: {quote}")
            if note := _bounded(_text(args, "note"), 160):
                detail.append(f"note: {note}")
            if color := _text(args, "color"):
                detail.append(f"color: {color}")
        case "nexus.edge.create":
            uri = _text(args, "source_uri")
            subject, target = _resource(uri, items)
            if uri and uri != subject:
                detail.append(uri)
            if destination := _named(_text(args, "target_uri"), items):
                detail.append(f"to: {destination}")
            if kind := _text(args, "kind") or _text(value, "kind"):
                detail.append(f"kind: {kind}")
            if rationale := _text(args, "rationale"):
                detail.append(rationale)
        case "nexus.queue.add":
            uri = _text(args, "media_uri")
            subject, target = _resource(uri, items)
            subject = _text(value, "title") or subject
            if uri and uri != subject:
                detail.append(uri)
            podcast = value.get("podcast")
            if isinstance(podcast, dict):
                operation = podcast.get("import")
                if isinstance(operation, dict):
                    state = _text(operation, "state")
                    outcome = "import " + state if state else "import accepted"
            elif value.get("already_present") is True:
                outcome = "already present"
            elif value.get("already_present") is False:
                outcome = "added"
        case "memory.search":
            subject = _text(args, "query")
            for key in ("stores", "kinds"):
                if (selected := _list(args, key)) is not None:
                    detail.append(
                        f"{key}: {', '.join(s for s in selected if isinstance(s, str)) or 'none'}"
                    )
            if (count := _integer(value, "returned")) is not None:
                outcome = f"{count} result{'s' if count != 1 else ''}"
                if (_integer(value, "omitted_limit") or 0) + (
                    _integer(value, "omitted_bytes") or 0
                ):
                    outcome += "; more results omitted"
        case "memory.open":
            identities = _list(args, "identities")
            event = args.get("event")
            if identities:
                subject = (
                    "; ".join(
                        f"{identity['store']}:{identity['id']}"
                        for identity in identities
                        if isinstance(identity, dict)
                        and _text(identity, "store")
                        and _text(identity, "id")
                    )
                    or None
                )
            elif isinstance(event, dict):
                conversation, event_id = (
                    _text(event, "conversation_id"),
                    _text(event, "native_event_id"),
                )
                if conversation and event_id:
                    subject = f"{conversation} · {event_id}"
            if _text(args, "cursor"):
                detail.append("continued read")
            if (records := _list(value, "records")) is not None:
                missing = sum(
                    isinstance(record, dict) and record.get("kind") == "missing"
                    for record in records
                )
                if missing:
                    outcome = f"{missing} record{'s' if missing != 1 else ''} unavailable"
                elif not records:
                    outcome = "no records returned"
            if _text(value, "cursor"):
                outcome = f"{outcome}; more available" if outcome else "more records available"
        case "memory.view":
            if _text(args, "cursor"):
                detail.append("continued read")
            if (nodes := _list(value, "nodes")) is not None:
                ranges = [
                    (start, start + count - 1)
                    for node in nodes
                    if isinstance(node, dict)
                    and (start := _integer(node, "start")) is not None
                    and (count := _integer(node, "count")) is not None
                ]
                if ranges:
                    subject = f"sources {min(start for start, _ in ranges)}–{max(end for _, end in ranges)}"
                elif not nodes:
                    outcome = "no sources returned"
            if _text(value, "cursor"):
                outcome = "more sources available"
        case "memory.zoom":
            start, count = _integer(args, "start"), _integer(args, "count")
            if start is not None and count is not None:
                subject = f"sources {start}–{start + count - 1}"
            if isinstance(value.get("record"), dict):
                outcome = "source record returned"
            elif isinstance(value.get("full_event"), dict):
                outcome = "event reference returned"
            elif (nodes := _list(value, "nodes")) is not None:
                outcome = f"{len(nodes)} source group{'s' if len(nodes) != 1 else ''}"
        case "memory.date":
            if (position := _integer(args, "position")) is not None:
                subject = f"source {position}"
            if occurred := _text(value, "occurred_at"):
                detail.append(f"occurred: {occurred}")
            elif "occurred_at" in value:
                detail.append("occurrence date unknown")
            if received := _text(value, "received_at"):
                detail.append(f"received: {received}")
            if value.get("note_created_at") is True:
                detail.append("date records note creation")
        case "memory.save_note":
            subject = _bounded(_text(args, "text"), 160)
            if receipt := _text(value, "id"):
                detail.append(f"receipt: {receipt}")
                outcome = "saved"
        case _:
            raise AssertionError(f"unprojected tool: {tool_id}")

    if (limit := _integer(args, "limit")) is not None:
        detail.append(f"limit: {limit}")
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
