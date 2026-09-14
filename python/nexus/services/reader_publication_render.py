"""Project the sanitized source tree into exactly the DOM nodes a reader admits."""

from __future__ import annotations

from typing import cast

from lxml import etree

from nexus.schemas.reader_publication import (
    ReaderPublicationAttributeNamespace,
    ReaderPublicationElementNamespace,
    ReaderPublicationRenderAttribute,
    ReaderPublicationRenderComment,
    ReaderPublicationRenderElement,
    ReaderPublicationRenderNode,
    ReaderPublicationRenderText,
)
from nexus.services.canonicalize import CanonicalTextBuilder
from nexus.services.svg_paint import project_svg_paint


def set_reader_source_attribute(element: etree._Element, name: str, value: str) -> None:
    """lxml's DOM setter needs expanded names for parsed xml:/xlink: attributes."""
    if ":" in name and not name.startswith("{"):
        from html5lib.constants import adjustForeignAttributes

        foreign = adjustForeignAttributes.get(name.lower())
        if foreign is None:
            raise ValueError("sanitized reader attribute has an unsupported prefix")
        _prefix, local, namespace = foreign
        element.attrib.pop(name, None)
        name = f"{{{namespace}}}{local}"
    element.set(name, value)


def _child_namespace(
    name: str,
    namespace: ReaderPublicationElementNamespace,
    parent_name: str,
    encoding: str,
) -> ReaderPublicationElementNamespace:
    from html5lib.constants import (
        htmlIntegrationPointElements,
        mathmlTextIntegrationPointElements,
        namespaces,
    )

    identity = (namespaces[namespace], parent_name.lower())
    if (
        identity in {(uri, tag.lower()) for uri, tag in htmlIntegrationPointElements}
        or identity in mathmlTextIntegrationPointElements
        and name not in {"mglyph", "malignmark"}
        or namespace == "mathml"
        and parent_name == "annotation-xml"
        and (encoding.lower() in {"text/html", "application/xhtml+xml"} or name == "svg")
    ):
        namespace = "html"
    if namespace == "html" and name in {"svg", "math"}:
        return "svg" if name == "svg" else "mathml"
    return namespace


def normalize_reader_tables(root: etree._Element) -> tuple[etree._Element, ...]:
    """Give geometry and display the same private effective HTML table tree.

    Only owned private trees may be passed here. Source strings remain unchanged.
    The implicit tbody rule is the existing direct render projection's rule.
    """
    tables: list[etree._Element] = []

    def visit(element: etree._Element, namespace: ReaderPublicationElementNamespace) -> None:
        if not isinstance(element.tag, str):
            return
        name = element.tag.rsplit("}", 1)[-1].lower()
        if namespace == "html" and name == "table":
            tables.append(element)
            body = None
            for child in tuple(element):
                if child.tag == "tr":
                    if body is None:
                        body = etree.Element("tbody")
                        child.addprevious(body)
                    body.append(child)
                else:
                    body = None
        for child in element:
            if isinstance(child.tag, str):
                child_name = child.tag.rsplit("}", 1)[-1].lower()
                visit(
                    child,
                    _child_namespace(child_name, namespace, name, element.get("encoding", "")),
                )

    for child in root:
        if isinstance(child.tag, str):
            visit(child, _child_namespace(child.tag.rsplit("}", 1)[-1].lower(), "html", "", ""))
    return tuple(tables)


def project_reader_render_nodes(root: etree._Element) -> tuple[ReaderPublicationRenderNode, ...]:
    """Omit the parser's synthetic root; preserve every source text/tail in order.

    This freezes the owned source tree, not HTML5 tree-recovery side effects.
    Foreign names use html5lib's maintained adjustments. No consumer reparses HTML.
    """
    from html5lib.constants import (
        adjustForeignAttributes,
        adjustMathMLAttributes,
        adjustSVGAttributes,
        namespaces,
    )
    from html5lib.html5parser import HTMLParser

    normalize_reader_tables(root)
    nodes: list[ReaderPublicationRenderNode] = []
    svg_adjuster = None

    def append_text(value: str | None, parent: int | None) -> None:
        if value:
            nodes.append(ReaderPublicationRenderText(parent=parent, text=value))

    def visit(source: etree._Element, parent: int | None) -> None:
        nonlocal svg_adjuster
        if not isinstance(source.tag, str):
            nodes.append(ReaderPublicationRenderComment(parent=parent, text=source.text or ""))
            return
        name = source.tag.rsplit("}", 1)[-1].lower()
        namespace: ReaderPublicationElementNamespace = "html"
        if parent is not None:
            holder = nodes[parent]
            assert isinstance(holder, ReaderPublicationRenderElement)
            namespace = holder.namespace
            encoding = next(
                (
                    attr.value
                    for attr in holder.attributes
                    if attr.name == "encoding" and isinstance(attr.value, str)
                ),
                "",
            )
            namespace = _child_namespace(name, namespace, holder.name, encoding)
        else:
            namespace = _child_namespace(name, "html", "", "")
        if namespace == "svg":
            # html5lib owns this mapping in its parser phase, not constants.py.
            if svg_adjuster is None:
                svg_adjuster = HTMLParser().phases["inForeignContent"].adjustSVGTagNames
            token = {"name": name}
            svg_adjuster(token)
            name = token["name"]
        attributes: list[ReaderPublicationRenderAttribute] = []
        for key, value in source.attrib.items():
            attr_namespace: ReaderPublicationAttributeNamespace | None = None
            if key.startswith("{"):
                uri, key = key[1:].split("}", 1)
                attr_namespace = next(
                    (
                        cast(ReaderPublicationAttributeNamespace, candidate)
                        for candidate in ("xlink", "xml", "xmlns")
                        if namespaces[candidate] == uri
                    ),
                    None,
                )
                if attr_namespace is None:
                    raise ValueError("sanitized reader attribute has an unsupported namespace")
            elif key.lower() in adjustForeignAttributes:
                _prefix, key, uri = adjustForeignAttributes[key.lower()]
                attr_namespace = cast(
                    ReaderPublicationAttributeNamespace,
                    next(
                        candidate
                        for candidate in ("xlink", "xml", "xmlns")
                        if namespaces[candidate] == uri
                    ),
                )
            elif namespace == "svg":
                key = adjustSVGAttributes.get(key.lower(), key)
            elif namespace == "mathml":
                key = adjustMathMLAttributes.get(key.lower(), key)
            projected = value
            if namespace == "svg" and key in {"fill", "stroke", "clip-path"}:
                projected = project_svg_paint(value)
                if projected is None:
                    continue
            attributes.append(
                ReaderPublicationRenderAttribute(
                    namespace=attr_namespace, name=key, value=projected
                )
            )
        index = len(nodes)
        nodes.append(
            ReaderPublicationRenderElement(
                parent=parent, namespace=namespace, name=name, attributes=tuple(attributes)
            )
        )
        append_text(source.text, index)
        for child in source:
            visit(child, index)
            append_text(child.tail, index)

    append_text(root.text, None)
    for child in root:
        visit(child, None)
        append_text(child.tail, None)
    return tuple(nodes)


def _canonical_builder(
    nodes: tuple[ReaderPublicationRenderNode, ...], element_ids: set[str] | None
) -> CanonicalTextBuilder:
    target = CanonicalTextBuilder(element_ids)
    target.start("div", {})
    ancestors: list[tuple[int, str]] = []
    for index, node in enumerate(nodes):
        while ancestors and ancestors[-1][0] != node.parent:
            _index, name = ancestors.pop()
            target.end(name)
        if isinstance(node, ReaderPublicationRenderElement):
            target.start(
                node.name,
                {
                    attr.name: attr.value
                    for attr in node.attributes
                    if attr.namespace is None and isinstance(attr.value, str)
                },
            )
            ancestors.append((index, node.name))
        elif isinstance(node, ReaderPublicationRenderText):
            target.data(node.text)
    while ancestors:
        _index, name = ancestors.pop()
        target.end(name)
    target.end("div")
    return target


def canonical_text_from_render_nodes(nodes: tuple[ReaderPublicationRenderNode, ...]) -> str:
    """Reuse the canonical-text owner on exact node events, without reparsing."""
    return _canonical_builder(nodes, set()).build()


def canonical_element_ids_from_render_nodes(
    nodes: tuple[ReaderPublicationRenderNode, ...],
) -> tuple[str, ...]:
    """Keep visible source marker order without inventing cropped source offsets."""
    return tuple(_canonical_builder(nodes, None).raw_offsets)
