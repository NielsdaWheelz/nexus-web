"""Markdown rendering of note blocks for prompt and object-ref contexts."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock


def page_outline_markdown(db: Session, *, viewer_id: UUID, page_id: UUID) -> str:
    from nexus.services.resource_graph import documents as graph_documents

    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page_id)
    return _document_outline_markdown(document.roots)


def note_block_outline_markdown(db: Session, *, viewer_id: UUID, block_id: UUID) -> str:
    from nexus.services.resource_graph import documents as graph_documents

    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
    document = graph_documents.load_page_document(
        db, user_id=viewer_id, page_id=occurrence.page_id
    )
    node = graph_documents.find_document_block(document, block_id)
    return _document_outline_markdown([node]) if node is not None else ""


def _document_outline_markdown(nodes: list[object]) -> str:
    lines: list[str] = []

    def visit(node: object, depth: int) -> None:
        lines.append(note_block_markdown(node.block, depth))
        for child in node.children:
            visit(child, depth + 1)

    for node in nodes:
        visit(node, 0)

    return "\n".join(lines).strip()


def note_block_markdown(block: NoteBlock, depth: int) -> str:
    indent = "  " * depth
    text_value = (block.body_markdown or block.body_text or "").strip()
    lines = text_value.splitlines() or [""]
    if block.block_kind == "heading":
        level = min(depth + 1, 6)
        rendered = [f"{indent}{'#' * level} {lines[0]}".rstrip()]
        rendered.extend(f"{indent}{line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "todo":
        rendered = [f"{indent}- [ ] {lines[0]}".rstrip()]
        rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "quote":
        return "\n".join(f"{indent}> {line}".rstrip() for line in lines)
    if block.block_kind == "code":
        return "\n".join([f"{indent}```", *[f"{indent}{line}" for line in lines], f"{indent}```"])
    rendered = [f"{indent}- {lines[0]}".rstrip()]
    rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
    return "\n".join(rendered)
