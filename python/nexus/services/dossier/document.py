"""The dossier article grammar: accept one model article and compile its citations.

The model writes one inert ``<article>``. html5lib parses it with zero errors, a
closed grammar accepts it (elements, seven classes, section ids, table attributes,
empty ``cite`` tokens; no links, urls, images or scripts), and a second parse of the
serialized result must be identical. Citations must be grounded: ordinals 1..n, each
token used once in reading order, each pointing at an offered candidate. The server,
never the model, then turns every token into its button. Nothing is repaired.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from xml.etree.ElementTree import Element, SubElement

import html5lib
from html5lib.serializer import serialize
from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_graph import EdgeKind
from nexus.services.dossier.inputs import Candidate
from nexus.services.resource_graph.citations import CitationInput

_HTML = "{http://www.w3.org/1999/xhtml}"
_ELEMENTS = frozenset(
    "section header h2 h3 h4 p ol ul li dl dt dd blockquote pre code em strong "
    "table thead tbody tr th td figure figcaption div span cite".split()
)
_CLASSES = frozenset(
    "dossier-lede dossier-definition dossier-example dossier-warning dossier-steps "
    "dossier-diagram dossier-muted".split()
)
_ROLES = frozenset({"supports", "contradicts", "context"})
_MAX_BYTES, _MAX_NODES, _MAX_DEPTH, _MAX_ATTRIBUTES, _MAX_CITES = 160_000, 4_000, 24, 8, 256
_SECTION_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_ORDINAL = re.compile(r"[1-9][0-9]*\Z")


class DocumentRejected(ValueError):
    def __init__(self, kind: Literal["Document", "Citation"], message: str) -> None:
        super().__init__(message)
        self.kind = kind


class CitationChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    ordinal: int
    candidate_index: int
    role: str


class Synthesis(BaseModel):
    """The model's strict json output."""

    model_config = ConfigDict(extra="forbid", strict=True)

    content_html: str
    citations: list[CitationChoice]


@dataclass(frozen=True, slots=True)
class Article:
    html: str
    text: str
    citations: tuple[CitationInput, ...]


def accept(output: Synthesis, candidates: Sequence[Candidate]) -> Article:
    fragment = _parse(output.content_html)
    ordinals = _accept_tree(fragment)
    reparsed = _parse(_serialize(fragment))
    if _accept_tree(reparsed) != ordinals or _shape(reparsed) != _shape(fragment):
        raise DocumentRejected("Document", "article changes when reparsed")
    article = fragment[0]
    text = " ".join(" ".join(article.itertext()).split())
    if not text:
        raise DocumentRejected("Document", "article has no readable text")

    choices = sorted(output.citations, key=lambda choice: choice.ordinal)
    expected = list(range(1, len(choices) + 1))
    if not choices:
        raise DocumentRejected("Citation", "article has no citations")
    if [choice.ordinal for choice in choices] != expected or ordinals != expected:
        raise DocumentRejected(
            "Citation", "citation ordinals must run 1..n, each token once, in reading order"
        )
    citations: list[CitationInput] = []
    for choice in choices:
        if not 0 <= choice.candidate_index < len(candidates):
            raise DocumentRejected(
                "Citation", f"citation {choice.ordinal} references an unknown candidate"
            )
        if choice.role not in _ROLES:
            raise DocumentRejected("Citation", f"citation {choice.ordinal} has an unknown role")
        candidate = candidates[choice.candidate_index]
        citations.append(
            CitationInput(
                target=candidate.target,
                ordinal=choice.ordinal,
                kind=cast(EdgeKind, choice.role),
                snapshot=candidate.snapshot,
            )
        )

    for parent in list(article.iter()):
        for index, child in enumerate(list(parent)):
            if child.tag == f"{_HTML}cite":
                ordinal = child.attrib["data-nexus-citation"]
                button = Element(
                    f"{_HTML}button",
                    {
                        "type": "button",
                        "class": "dossier-citation",
                        "data-nexus-citation": ordinal,
                        "aria-label": f"Open citation {ordinal}",
                    },
                )
                SubElement(button, f"{_HTML}sup").text = ordinal
                button.tail = child.tail
                parent.remove(child)
                parent.insert(index, button)
    return Article(html=_serialize(fragment), text=text, citations=tuple(citations))


def _parse(source: str) -> Element:
    """The fragment holding exactly one ``<article>``, padding stripped."""
    if len(source.encode()) > _MAX_BYTES:
        raise DocumentRejected("Document", f"article exceeds {_MAX_BYTES} bytes")
    parser = html5lib.HTMLParser(namespaceHTMLElements=True)
    fragment = parser.parseFragment(source)
    if parser.errors:
        raise DocumentRejected("Document", f"article has HTML parse errors: {parser.errors[0][1]}")
    children = list(fragment)
    if (
        (fragment.text or "").strip()
        or len(children) != 1
        or children[0].tag != f"{_HTML}article"
        or (children[0].tail or "").strip()
    ):
        raise DocumentRejected("Document", "document must be exactly one top-level article")
    fragment.text = children[0].tail = None
    return fragment


def _accept_tree(fragment: Element) -> list[int]:
    """Walk the article (``_parse`` admitted its root) against the grammar; return its ordinals."""
    ordinals: list[int] = []
    section_ids: set[str] = set()
    nodes = 0
    stack = [(fragment[0], 1)]
    while stack:
        element, depth = stack.pop()
        tag = element.tag if isinstance(element.tag, str) else ""
        name = tag.removeprefix(_HTML)
        if not tag.startswith(_HTML) or (depth > 1 and name not in _ELEMENTS):
            raise DocumentRejected("Document", f"element {name or 'comment'!r} is forbidden")
        nodes += 1 + (element.text is not None) + (element.tail is not None)
        if nodes > _MAX_NODES or depth > _MAX_DEPTH or len(element.attrib) > _MAX_ATTRIBUTES:
            raise DocumentRejected("Document", "article exceeds its node, depth or attribute limit")
        attributes = element.attrib
        if name == "cite":
            raw = attributes.get("data-nexus-citation", "")
            if set(attributes) != {"data-nexus-citation"} or len(element) or element.text:
                raise DocumentRejected("Document", "cite must be one empty citation token")
            if _ORDINAL.match(raw) is None:
                raise DocumentRejected("Document", "citation ordinal must be a positive integer")
            ordinals.append(int(raw))
            continue
        allowed = {
            "article": set(),
            "section": {"id", "class"},
            "th": {"class", "scope", "colspan", "rowspan"},
            "td": {"class", "scope", "colspan", "rowspan"},
        }.get(name, {"class"})
        if set(attributes) - allowed:
            raise DocumentRejected("Document", f"element {name!r} has forbidden attributes")
        if name == "section":
            section_id = attributes.get("id", "")
            if _SECTION_ID.match(section_id) is None or section_id in section_ids:
                raise DocumentRejected("Document", "each section needs one unique lowercase id")
            section_ids.add(section_id)
        if "class" in attributes:
            tokens = attributes["class"].split(" ")
            if len(set(tokens)) != len(tokens) or not set(tokens) <= _CLASSES:
                raise DocumentRejected("Document", "class is not in the closed dossier vocabulary")
        if attributes.get("scope", "row") not in {"row", "col"}:
            raise DocumentRejected("Document", "table scope must be row or col")
        for span in (attributes.get("colspan"), attributes.get("rowspan")):
            if span is not None and (_ORDINAL.match(span) is None or int(span) > 16):
                raise DocumentRejected("Document", "colspan and rowspan run 1 to 16")
        stack.extend((child, depth + 1) for child in reversed(element))
    if len(ordinals) > _MAX_CITES:
        raise DocumentRejected("Document", f"article exceeds {_MAX_CITES} citations")
    return ordinals


def _serialize(fragment: Element) -> str:
    return serialize(
        fragment,
        tree="etree",
        quote_attr_values="always",
        omit_optional_tags=False,
        alphabetical_attributes=False,
    )


def _shape(element: Element) -> tuple[object, ...]:
    return (
        element.tag,
        tuple(element.attrib.items()),
        element.text,
        element.tail,
        tuple(_shape(child) for child in element),
    )
