from __future__ import annotations

import io
import re
import tarfile
from collections import Counter
from dataclasses import dataclass

_CITATION_COMMANDS = {
    "autocite",
    "cite",
    "parencite",
    "textcite",
}


@dataclass(frozen=True)
class LatexSourceGraph:
    marker_keys: tuple[tuple[str, ...], ...]
    cited_keys: tuple[str, ...]
    bib_keys: tuple[str, ...]
    footnote_count: int

    @property
    def marker_count(self) -> int:
        return len(self.marker_keys)

    @property
    def edge_count(self) -> int:
        return len(self.cited_keys)

    @property
    def cited_entry_count(self) -> int:
        return len(set(self.cited_keys))

    @property
    def bib_entry_count(self) -> int:
        return len(self.bib_keys)

    @property
    def uncited_entry_count(self) -> int:
        return len(set(self.bib_keys) - set(self.cited_keys))


def verify_arxiv_latex_biblatex_graph(source_bytes: bytes) -> LatexSourceGraph:
    graph = latex_source_graph_from_archive(source_bytes)
    missing = sorted(set(graph.cited_keys) - set(graph.bib_keys))
    assert missing == []
    assert len(graph.bib_keys) == len(set(graph.bib_keys))
    assert Counter(graph.cited_keys)["colavizza2017annotated"] == 2
    assert Counter(graph.cited_keys)["zhu2026benchmarking"] == 2
    return graph


def latex_source_graph_from_archive(source_bytes: bytes) -> LatexSourceGraph:
    tex, bib = _archive_tex_and_bib(source_bytes)
    tex_without_comments = _strip_latex_comments(tex)
    marker_keys = _citation_marker_keys(tex_without_comments)
    cited_keys = tuple(key for keys in marker_keys for key in keys)
    bib_keys = tuple(re.findall(r"@\w+\s*\{\s*([^,\s]+)", bib))
    footnote_count = len(re.findall(r"\\footnote(?:text)?(?:\[[^\]]+\])?\{", tex_without_comments))
    return LatexSourceGraph(
        marker_keys=marker_keys,
        cited_keys=cited_keys,
        bib_keys=bib_keys,
        footnote_count=footnote_count,
    )


def _archive_tex_and_bib(source_bytes: bytes) -> tuple[str, str]:
    tex_candidates: list[tuple[str, str]] = []
    bib_parts: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r:*") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            assert extracted is not None
            payload = extracted.read().decode("utf-8", errors="replace")
            if member.name.endswith(".tex") and "\\begin{document}" in payload:
                tex_candidates.append((member.name, payload))
            if member.name.endswith(".bib"):
                bib_parts.append(payload)
    assert tex_candidates
    assert bib_parts
    return sorted(tex_candidates)[0][1], "\n\n".join(bib_parts)


def _citation_marker_keys(tex: str) -> tuple[tuple[str, ...], ...]:
    markers: list[tuple[str, ...]] = []
    for match in re.finditer(r"\\([A-Za-z]+)\*?", tex):
        command = match.group(1)
        if command not in _CITATION_COMMANDS:
            continue
        parsed = _latex_command_argument(tex, match.end())
        if parsed is None:
            continue
        keys_body, _end = parsed
        keys = tuple(key.strip() for key in keys_body.split(",") if key.strip())
        if keys:
            markers.append(keys)
    return tuple(markers)


def _latex_command_argument(tex: str, pos: int) -> tuple[str, int] | None:
    pos = _skip_spaces(tex, pos)
    while pos < len(tex) and tex[pos] == "[":
        optional = _balanced_group(tex, pos, "[", "]")
        if optional is None:
            return None
        _, pos = optional
        pos = _skip_spaces(tex, pos)
    if pos >= len(tex) or tex[pos] != "{":
        return None
    return _balanced_group(tex, pos, "{", "}")


def _strip_latex_comments(tex: str) -> str:
    lines: list[str] = []
    for line in tex.splitlines():
        cut_at: int | None = None
        for index, char in enumerate(line):
            if char != "%":
                continue
            backslash_count = 0
            cursor = index - 1
            while cursor >= 0 and line[cursor] == "\\":
                backslash_count += 1
                cursor -= 1
            if backslash_count % 2 == 0:
                cut_at = index
                break
        lines.append(line[:cut_at] if cut_at is not None else line)
    return "\n".join(lines)


def _balanced_group(text: str, start: int, opener: str, closer: str) -> tuple[str, int] | None:
    if start >= len(text) or text[start] != opener:
        return None
    depth = 0
    pos = start
    escaped = False
    while pos < len(text):
        char = text[pos]
        if char == "\\" and not escaped:
            escaped = True
            pos += 1
            continue
        if not escaped:
            if char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    return text[start + 1 : pos], pos + 1
        escaped = False
        pos += 1
    return None


def _skip_spaces(text: str, pos: int) -> int:
    while pos < len(text) and text[pos].isspace():
        pos += 1
    return pos
