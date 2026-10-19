"""Notes wire: the note body grammar, pages, the daily page, outlines and their commands.

Every model is closed and snake_case. A body is one ProseMirror block (I1/I2): a
paragraph (text, hard_break, image), a code_block (text only) or an object_embed;
marks are strong, em, code, link, strikethrough and underline. ``validate_body`` is
mirrored by ``lib/notes/noteBody.ts``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES

_INLINE = frozenset({"text", "hard_break", "image"})
# What each node may contain: None is an atom or an inline leaf.
_CHILDREN: dict[str, frozenset[str] | None] = {
    "paragraph": _INLINE,
    "code_block": frozenset({"text"}),
    "object_embed": None,
    "text": None,
    "hard_break": None,
    "image": None,
}
_MARKS = frozenset({"strong", "em", "code", "link", "strikethrough", "underline"})


def _uuid(value: object) -> bool:
    try:
        UUID(str(value))
    except ValueError:
        return False
    return isinstance(value, str)


def _text(value: object) -> bool:
    return isinstance(value, str)


def _optional(value: object) -> bool:
    return value is None or isinstance(value, str)


def safe_href(href: object) -> bool:
    """`/`-relative (not `//`), http(s) with a host and no `%` in the authority, or a
    mailto without an authority (I2)."""
    if not isinstance(href, str) or not href:
        return False
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == "\\" for c in href):
        return False
    if href.startswith("/"):
        return not href.startswith("//")
    try:
        parts = urlsplit(href)
        if parts.scheme in ("http", "https"):
            _ = parts.port  # a malformed or out-of-range port is refused, as browsers do
            return "%" not in parts.netloc and bool(parts.hostname)
    except ValueError:
        return False
    return parts.scheme == "mailto" and bool(parts.path) and not parts.netloc


# The attrs a node or mark is checked on: name -> (required, check). Others pass.
_ATTRS: dict[str, dict[str, tuple[bool, Callable[[object], bool]]]] = {
    "object_embed": {
        "objectType": (True, lambda value: value in RESOURCE_SCHEMES),
        "objectId": (True, _uuid),
        "label": (False, _optional),
        "relationType": (False, lambda value: value in (None, "embeds")),
        "displayMode": (False, _optional),
    },
    "image": {"src": (True, _text), "alt": (False, _optional), "title": (False, _optional)},
    "link": {"href": (True, safe_href), "title": (False, _optional)},
}


def validate_body(body: dict[str, Any]) -> dict[str, Any]:
    """The note body grammar; raises ValueError naming the first offending path."""
    _node(body, "body_pm_json", frozenset({"paragraph", "code_block", "object_embed"}))
    return body


def _node(node: object, path: str, allowed: frozenset[str]) -> None:
    if not isinstance(node, dict) or node.get("type") not in allowed:
        raise ValueError(f"{path} is not one of {sorted(allowed)}")
    if set(node) - {"type", "attrs", "content", "marks", "text"}:
        raise ValueError(f"{path} has unsupported fields")
    kind = node["type"]
    _attrs(kind, node.get("attrs"), path)
    marks = node.get("marks", [])
    if not isinstance(marks, list):
        raise ValueError(f"{path}.marks must be a list")
    for index, mark in enumerate(marks):
        if (
            not isinstance(mark, dict)
            or mark.get("type") not in _MARKS
            or set(mark) - {"type", "attrs"}
        ):
            raise ValueError(f"{path}.marks[{index}] is not a known mark")
        _attrs(mark["type"], mark.get("attrs"), f"{path}.marks[{index}]")
    if kind == "text":
        if not isinstance(node.get("text"), str) or not node["text"] or "content" in node:
            raise ValueError(f"{path} must be non-empty text")
        return
    if "text" in node:
        raise ValueError(f"{path}.text is only valid on text")
    content = node.get("content")
    if content is None:
        return
    children = _CHILDREN[kind]
    if children is None or not isinstance(content, list):
        raise ValueError(f"{path}.content is not allowed here")
    for index, child in enumerate(content):
        _node(child, f"{path}.content[{index}]", children)


def _attrs(kind: str, attrs: object, path: str) -> None:
    if attrs is not None and not isinstance(attrs, dict):
        raise ValueError(f"{path}.attrs must be an object")
    for name, (required, check) in _ATTRS.get(kind, {}).items():
        value = attrs.get(name) if isinstance(attrs, dict) else None
        if (required or value is not None) and not check(value):
            raise ValueError(f"{path}.attrs.{name} is invalid")


Body = Annotated[dict[str, Any], AfterValidator(validate_body)]
Title = Annotated[str, Field(min_length=1, max_length=200)]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


# pages, the daily page, note rows and annotations


class NotePageSummaryOut(_Closed):
    id: UUID
    title: str
    updated_at: datetime


class CreatePageRequest(_Closed):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: UUID
    title: Title


class DailyCaptureRequest(_Closed):
    note_id: UUID
    text: str


class DailyCaptureOut(_Closed):
    page_id: UUID


class NoteBlockOut(_Closed):
    id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    body_version: int
    embedded_item: ResourceItemOut | None = None


class AnnotationNoteRequest(_Closed):
    """Create the one note of a highlight or link and attach it."""

    note_id: UUID
    body_pm_json: Body


# outlines


class PageContentOut(_Closed):
    kind: Literal["page"]
    title: str
    title_version: int
    daily_date: date | None


class NoteContentOut(_Closed):
    """``places``: the note's user links, annotations, link notes and citations."""

    kind: Literal["note"]
    body_pm_json: dict[str, Any]
    body_text: str
    body_version: int
    embedded_item: ResourceItemOut | None = None
    places: int


class ResourceContentOut(_Closed):
    kind: Literal["resource"]


class OutlineNodeOut(_Closed):
    item: ResourceItemOut
    content: Annotated[
        PageContentOut | NoteContentOut | ResourceContentOut, Field(discriminator="kind")
    ]


class OutlineLinkOut(_Closed):
    link_id: UUID
    has_link_note: bool
    target: OutlineNodeOut


class OutlineOut(_Closed):
    """A page's or note's user links in that endpoint's own order."""

    source: OutlineNodeOut
    links: list[OutlineLinkOut]


class DailyPageOut(_Closed):
    """A latent day carries its page's future id and default title, and no links."""

    local_date: date
    materialized: bool
    outline: OutlineOut


# outline commands: idempotent primitives (services/outline.py states each retry rule)


class SetBody(_Closed):
    kind: Literal["set_body"]
    note_id: UUID
    body_pm_json: Body
    expected_version: int


class SetTitle(_Closed):
    kind: Literal["set_title"]
    page_id: UUID
    title: Title
    expected_version: int


class EnsureDaily(_Closed):
    kind: Literal["ensure_daily"]
    local_date: date


class InsertNote(_Closed):
    kind: Literal["insert_note"]
    endpoint: str
    link_id: UUID
    note_id: UUID
    after: UUID | None
    body_pm_json: Body


class InsertResource(_Closed):
    kind: Literal["insert_resource"]
    endpoint: str
    link_id: UUID
    target: str
    after: UUID | None


class Move(_Closed):
    kind: Literal["move"]
    endpoint: str
    link_id: UUID
    after: UUID | None


class Relink(_Closed):
    kind: Literal["relink"]
    endpoint: str
    link_id: UUID
    destination: str
    new_link_id: UUID
    after: UUID | None


class Remove(_Closed):
    kind: Literal["remove"]
    endpoint: str
    link_id: UUID
    expected_body_version: int | None


class Unlink(_Closed):
    kind: Literal["unlink"]
    link_id: UUID
    require_unannotated: bool


OutlineCommand = Annotated[
    SetBody
    | SetTitle
    | EnsureDaily
    | InsertNote
    | InsertResource
    | Move
    | Relink
    | Remove
    | Unlink,
    Field(discriminator="kind"),
]


class OutlineCommandsRequest(_Closed):
    commands: list[OutlineCommand] = Field(min_length=1, max_length=1000)


class OutlineCommandsOut(_Closed):
    """Changed outlines, written nodes and deleted notes; unlink only acknowledges (empty lists)."""

    outlines: list[OutlineOut]
    nodes: list[OutlineNodeOut]
    deleted: list[str]
