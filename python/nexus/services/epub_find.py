"""Reader Find snippet projection shared by the publication find query."""

from __future__ import annotations

from nexus.schemas.epub_find import EpubFindSnippetSegmentOut

SNIPPET_CONTEXT_CODEPOINTS = 64


def build_reader_find_snippet(
    canonical_text: str,
    start_offset: int,
    end_offset: int,
) -> list[EpubFindSnippetSegmentOut]:
    snippet_start = max(0, start_offset - SNIPPET_CONTEXT_CODEPOINTS)
    snippet_end = min(len(canonical_text), end_offset + SNIPPET_CONTEXT_CODEPOINTS)
    parts = (
        (canonical_text[snippet_start:start_offset], False),
        (canonical_text[start_offset:end_offset], True),
        (canonical_text[end_offset:snippet_end], False),
    )
    return [
        EpubFindSnippetSegmentOut(text=value, emphasized=emphasized)
        for value, emphasized in parts
        if value
    ]
