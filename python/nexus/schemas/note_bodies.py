"""Canonical single-block note body grammar and annotation creation payload.

The browser mirrors validate_body; reference search never becomes this body until
an explicit handoff returns it to ordinary prose editing.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict

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


def _node(node: object, path: str, allowed: frozenset[str], code_marks: bool = True) -> None:
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
        if marks and not code_marks:
            raise ValueError(f"{path} is code and takes no marks")
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
        _node(child, f"{path}.content[{index}]", children, kind != "code_block")


def _attrs(kind: str, attrs: object, path: str) -> None:
    if attrs is not None and not isinstance(attrs, dict):
        raise ValueError(f"{path}.attrs must be an object")
    for name, (required, check) in _ATTRS.get(kind, {}).items():
        value = attrs.get(name) if isinstance(attrs, dict) else None
        if (required or value is not None) and not check(value):
            raise ValueError(f"{path}.attrs.{name} is invalid")


Body = Annotated[dict[str, Any], AfterValidator(validate_body)]


class AnnotationNoteRequest(BaseModel):
    """Create the one ordinary note of a highlight or user link and attach it."""

    model_config = ConfigDict(extra="forbid")
    note_id: UUID
    body_pm_json: Body
