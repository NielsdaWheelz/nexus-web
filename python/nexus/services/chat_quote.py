"""Shared XML renderer for quote-shaped prompt blocks.

One renderer for every passage shown to the model with prefix/exact/suffix
context: the ``<quote>`` inside a ``<resource>`` highlight, the
``<reader_selection>`` turn anchor, and the ``<assistant_selection>`` branch
anchor. Every leaf is ``xml_escape``d at the interpolation site
(generated-text.md). Named ``chat_quote`` to avoid the unrelated
``_render_quote_block`` in ``x_api`` (HTML quote-tweets).
"""

from __future__ import annotations

from xml.sax.saxutils import escape as xml_escape


def render_quote_block(
    tag: str,
    *,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    source_label: str | None = None,
    note: str | None = None,
    offset_status: str | None = None,
) -> str:
    if source_label:
        source_attr = xml_escape(source_label, {'"': "&quot;"})
        lines = [f'<{tag} source="{source_attr}">']
    else:
        lines = [f"<{tag}>"]
    if offset_status in {"mapped", "unmapped"}:
        lines.append(f"<offset_status>{offset_status}</offset_status>")
    if prefix:
        lines.append(f"<prefix>{xml_escape(prefix)}</prefix>")
    lines.append(f"<exact>{xml_escape(exact)}</exact>")
    if suffix:
        lines.append(f"<suffix>{xml_escape(suffix)}</suffix>")
    if note:
        lines.append(f"<note>{xml_escape(note)}</note>")
    lines.append(f"</{tag}>")
    return "\n".join(lines)
