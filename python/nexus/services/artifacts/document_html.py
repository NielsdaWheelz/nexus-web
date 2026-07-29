"""Fail-closed acceptance and compilation for generated Dossier articles.

The model supplies one inert semantic ``article`` fragment.  This owner parses it
with the WHATWG algorithm, accepts a closed grammar, proves serialization is
stable under a second parse, and returns the only model-authored representation
the application may persist.  Citation controls are compiled separately from
strictly materialized citations; model output can never create an active control.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from xml.etree.ElementTree import Element, SubElement

import html5lib
from html5lib.serializer import serialize

from nexus.services.resource_graph.schemas import CitationInput

_HTML_NAMESPACE = "http://www.w3.org/1999/xhtml"
_MAX_SERIALIZED_BYTES = 160_000
_MAX_NODES = 4_000
_MAX_DEPTH = 24
_MAX_ATTRIBUTES = 8
_MAX_CITATIONS = 256
_TOKEN = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_POSITIVE_INTEGER = re.compile(r"[1-9][0-9]*\Z")
_ALLOWED_ELEMENTS = frozenset(
    {
        "article",
        "section",
        "header",
        "h2",
        "h3",
        "h4",
        "p",
        "ol",
        "ul",
        "li",
        "dl",
        "dt",
        "dd",
        "blockquote",
        "pre",
        "code",
        "em",
        "strong",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "figure",
        "figcaption",
        "div",
        "span",
        "cite",
    }
)
_ALLOWED_CLASSES = frozenset(
    {
        "dossier-lede",
        "dossier-definition",
        "dossier-example",
        "dossier-warning",
        "dossier-steps",
        "dossier-diagram",
        "dossier-muted",
    }
)
_TABLE_ATTRIBUTES = frozenset({"scope", "colspan", "rowspan", "class"})
_GENERIC_ATTRIBUTES = frozenset({"class"})
_TRUSTED_ELEMENTS = _ALLOWED_ELEMENTS | {"button", "sup"}


class DocumentHtmlError(ValueError):
    """Generated markup is not in the accepted Dossier document language."""


@dataclass(frozen=True, slots=True)
class AcceptedModelArticle:
    """Canonical inert article plus the citation ordinals it contains."""

    content_html: str
    citation_ordinals: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class CompiledLearningDocument:
    """The persisted article and its derived plain-text projection."""

    content_html: str
    content_text: str


def accept_model_article(content_html: str) -> AcceptedModelArticle:
    """Accept one model-authored semantic article without repairing it."""

    fragment = _parse_fragment(content_html)
    citation_ordinals = _validate_model_fragment(fragment)
    _strip_fragment_padding(fragment)
    canonical = _serialize(fragment)
    if len(canonical.encode("utf-8")) > _MAX_SERIALIZED_BYTES:
        raise DocumentHtmlError("article exceeds the 160000-byte limit")

    reparsed = _parse_fragment(canonical)
    reparsed_ordinals = _validate_model_fragment(reparsed)
    _strip_fragment_padding(reparsed)
    if _tree_shape(fragment) != _tree_shape(reparsed):
        raise DocumentHtmlError("article changes shape when reparsed")
    if citation_ordinals != reparsed_ordinals:
        raise DocumentHtmlError("citation tokens change when reparsed")
    return AcceptedModelArticle(
        content_html=canonical,
        citation_ordinals=citation_ordinals,
    )


def compile_learning_document(
    accepted: AcceptedModelArticle,
    citations: Sequence[CitationInput],
) -> CompiledLearningDocument:
    """Replace accepted inert tokens with exact app-owned citation controls."""

    ordinals = tuple(citation.ordinal for citation in citations)
    if ordinals != accepted.citation_ordinals:
        raise AssertionError("compiled citations do not match the accepted document")

    fragment = _parse_fragment(accepted.content_html)
    article = _only_article(fragment)
    content_text = " ".join(" ".join(article.itertext()).split())
    if not content_text:
        raise DocumentHtmlError("article has no readable text")

    for parent in article.iter():
        children = list(parent)
        for index, child in enumerate(children):
            if _local_name(child) != "cite":
                continue
            ordinal = int(child.attrib["data-nexus-citation"])
            control = Element(
                _qualified("button"),
                {
                    "type": "button",
                    "class": "dossier-citation",
                    "data-nexus-citation": str(ordinal),
                    "aria-label": f"Open citation {ordinal}",
                },
            )
            superscript = SubElement(control, _qualified("sup"))
            superscript.text = str(ordinal)
            control.tail = child.tail
            parent.remove(child)
            parent.insert(index, control)

    compiled = _serialize(fragment)
    reparsed = _parse_fragment(compiled)
    _validate_compiled_fragment(reparsed, expected_ordinals=ordinals)
    if _tree_shape(fragment) != _tree_shape(reparsed):
        raise AssertionError("trusted citation controls change shape when reparsed")
    return CompiledLearningDocument(content_html=compiled, content_text=content_text)


def _parse_fragment(source: str) -> Element:
    if not isinstance(source, str):
        raise DocumentHtmlError("article body must be a string")
    if len(source.encode("utf-8")) > _MAX_SERIALIZED_BYTES:
        raise DocumentHtmlError("article exceeds the 160000-byte limit")
    parser = html5lib.HTMLParser(namespaceHTMLElements=True)
    try:
        fragment = parser.parseFragment(source)
    except Exception as exc:
        raise DocumentHtmlError("article is not parseable HTML") from exc
    if parser.errors:
        raise DocumentHtmlError(f"article has HTML parse errors: {parser.errors[0][1]}")
    return fragment


def _validate_model_fragment(fragment: Element) -> tuple[int, ...]:
    article = _only_article(fragment)
    section_ids: set[str] = set()
    citation_ordinals: list[int] = []
    node_count = 0
    stack = [(article, 1)]
    while stack:
        element, depth = stack.pop()
        node_count += (
            1 + int(element.text is not None) + int(depth > 1 and element.tail is not None)
        )
        if node_count > _MAX_NODES:
            raise DocumentHtmlError("article exceeds the 4000-node limit")
        if depth > _MAX_DEPTH:
            raise DocumentHtmlError("article exceeds the depth limit")
        if not isinstance(element.tag, str):
            raise DocumentHtmlError("comments and processing instructions are forbidden")
        name = _local_name(element)
        if name not in _ALLOWED_ELEMENTS:
            raise DocumentHtmlError(f"element {name!r} is forbidden")
        if len(element.attrib) > _MAX_ATTRIBUTES:
            raise DocumentHtmlError("element exceeds the attribute limit")
        _validate_model_attributes(
            element,
            name=name,
            section_ids=section_ids,
            citation_ordinals=citation_ordinals,
        )
        stack.extend((child, depth + 1) for child in reversed(list(element)))

    if len(citation_ordinals) > _MAX_CITATIONS:
        raise DocumentHtmlError("article exceeds the citation-token limit")
    return tuple(citation_ordinals)


def _validate_model_attributes(
    element: Element,
    *,
    name: str,
    section_ids: set[str],
    citation_ordinals: list[int],
) -> None:
    attributes = element.attrib
    if any(_attribute_namespace(key) is not None for key in attributes):
        raise DocumentHtmlError("namespaced attributes are forbidden")

    if name == "article":
        if attributes:
            raise DocumentHtmlError("article cannot have model-authored attributes")
        return

    if name == "cite":
        if set(attributes) != {"data-nexus-citation"} or list(element):
            raise DocumentHtmlError("cite must be one empty citation token")
        if element.text not in (None, ""):
            raise DocumentHtmlError("citation token must be empty")
        raw_ordinal = attributes["data-nexus-citation"]
        if _POSITIVE_INTEGER.fullmatch(raw_ordinal) is None:
            raise DocumentHtmlError("citation ordinal must be a canonical positive integer")
        ordinal = int(raw_ordinal)
        citation_ordinals.append(ordinal)
        return

    allowed = (
        {"id", "class"}
        if name == "section"
        else _TABLE_ATTRIBUTES
        if name in {"th", "td"}
        else _GENERIC_ATTRIBUTES
    )
    unknown = set(attributes) - allowed
    if unknown:
        raise DocumentHtmlError(f"element {name!r} has forbidden attributes")

    if name == "section":
        section_id = attributes.get("id")
        if section_id is None or _TOKEN.fullmatch(section_id) is None:
            raise DocumentHtmlError("section requires one canonical id")
        if section_id in section_ids:
            raise DocumentHtmlError("section ids must be unique")
        section_ids.add(section_id)

    classes = attributes.get("class")
    if classes is not None:
        tokens = classes.split(" ")
        if (
            not tokens
            or any(not token for token in tokens)
            or len(tokens) != len(set(tokens))
            or any(token not in _ALLOWED_CLASSES for token in tokens)
        ):
            raise DocumentHtmlError("class is not in the closed Dossier vocabulary")

    scope = attributes.get("scope")
    if scope is not None and scope not in {"row", "col"}:
        raise DocumentHtmlError("table scope must be row or col")
    for key in ("colspan", "rowspan"):
        value = attributes.get(key)
        if value is not None and (
            _POSITIVE_INTEGER.fullmatch(value) is None or not 1 <= int(value) <= 16
        ):
            raise DocumentHtmlError(f"{key} must be a canonical integer from 1 to 16")


def _validate_compiled_fragment(
    fragment: Element,
    *,
    expected_ordinals: tuple[int, ...],
) -> None:
    article = _only_article(fragment)
    found: list[int] = []
    node_count = 0
    stack = [(article, 1)]
    while stack:
        element, depth = stack.pop()
        node_count += (
            1 + int(element.text is not None) + int(depth > 1 and element.tail is not None)
        )
        if node_count > _MAX_NODES + 2 * _MAX_CITATIONS:
            raise AssertionError("compiled article exceeds trusted node bound")
        if depth > _MAX_DEPTH + 1:
            raise AssertionError("compiled article exceeds trusted depth bound")
        name = _local_name(element)
        if name not in _TRUSTED_ELEMENTS:
            raise AssertionError(f"compiled article contains unexpected {name!r}")
        if name == "cite":
            raise AssertionError("compiled article retained a model citation token")
        if name == "button":
            if list(element.attrib) != [
                "type",
                "class",
                "data-nexus-citation",
                "aria-label",
            ]:
                raise AssertionError("compiled citation attributes changed")
            raw_ordinal = element.attrib["data-nexus-citation"]
            ordinal = int(raw_ordinal)
            if element.attrib != {
                "type": "button",
                "class": "dossier-citation",
                "data-nexus-citation": raw_ordinal,
                "aria-label": f"Open citation {ordinal}",
            }:
                raise AssertionError("compiled citation control is malformed")
            children = list(element)
            if (
                len(children) != 1
                or _local_name(children[0]) != "sup"
                or children[0].attrib
                or children[0].text != raw_ordinal
                or list(children[0])
            ):
                raise AssertionError("compiled citation superscript is malformed")
            found.append(ordinal)
        stack.extend((child, depth + 1) for child in reversed(list(element)))
    if tuple(found) != expected_ordinals:
        raise AssertionError("compiled citation order changed")


def _only_article(fragment: Element) -> Element:
    if (fragment.text or "").strip():
        raise DocumentHtmlError("text outside the article is forbidden")
    children = list(fragment)
    if (
        len(children) != 1
        or not isinstance(children[0].tag, str)
        or _local_name(children[0]) != "article"
        or (children[0].tail or "").strip()
    ):
        raise DocumentHtmlError("document must contain exactly one top-level article")
    return children[0]


def _strip_fragment_padding(fragment: Element) -> None:
    article = _only_article(fragment)
    fragment.text = None
    article.tail = None


def _local_name(element: Element) -> str:
    if not isinstance(element.tag, str):
        raise DocumentHtmlError("comments and processing instructions are forbidden")
    prefix = f"{{{_HTML_NAMESPACE}}}"
    if not element.tag.startswith(prefix):
        raise DocumentHtmlError("foreign namespaces are forbidden")
    return element.tag[len(prefix) :]


def _attribute_namespace(name: str) -> str | None:
    return name[1:].partition("}")[0] if name.startswith("{") else None


def _qualified(name: str) -> str:
    return f"{{{_HTML_NAMESPACE}}}{name}"


def _serialize(fragment: Element) -> str:
    return serialize(
        fragment,
        tree="etree",
        quote_attr_values="always",
        omit_optional_tags=False,
        alphabetical_attributes=False,
    )


def _tree_shape(element: Element) -> tuple[object, ...]:
    return (
        element.tag,
        tuple(element.attrib.items()),
        element.text,
        element.tail,
        tuple(_tree_shape(child) for child in element),
    )
