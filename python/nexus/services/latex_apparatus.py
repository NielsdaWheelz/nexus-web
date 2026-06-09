"""Structured LaTeX/BibTeX reader apparatus extraction."""

from __future__ import annotations

import io
import re
import tarfile
from collections.abc import Mapping
from dataclasses import dataclass, field

from nexus.config import get_settings
from nexus.text import normalize_whitespace

_CITATION_COMMANDS = {
    "autocite",
    "cite",
    "parencite",
    "textcite",
}
_FOOTNOTE_COMMANDS = {
    "footnote",
    "footnotetext",
}
_MAX_SOURCE_FILE_BYTES = 2_000_000


class LatexSourceArchiveUnsafe(ValueError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class LatexBiblatexApparatus:
    status: str = "empty"
    items: list[dict[str, object]] = field(default_factory=list)
    edges: list[dict[str, object]] = field(default_factory=list)
    diagnostics: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class LatexSourceArchiveSafetyConfig:
    max_entries: int
    max_total_uncompressed_bytes: int
    max_single_entry_uncompressed_bytes: int
    max_compression_ratio: int


@dataclass(frozen=True)
class LatexCitationMarker:
    ordinal: int
    command: str
    keys: tuple[str, ...]
    raw: str
    sort_key: str


@dataclass(frozen=True)
class BibEntry:
    key: str
    entry_type: str
    fields: Mapping[str, str]


@dataclass(frozen=True)
class LatexFootnote:
    ordinal: int
    command: str
    label: str
    body_text: str
    sort_key: str


def extract_latex_biblatex_apparatus_from_archive(
    source_bytes: bytes,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    safety_cfg: LatexSourceArchiveSafetyConfig | None = None,
) -> LatexBiblatexApparatus:
    files = _source_archive_text_files(source_bytes, safety_cfg=safety_cfg)
    tex_name, tex = _primary_tex_file(files)
    bib_resource_names = _bib_resource_names(tex)
    bib_names = bib_resource_names or tuple(name for name in files if name.lower().endswith(".bib"))
    bib_parts: list[str] = []
    missing_bib_resources: list[str] = []
    for bib_name in bib_names:
        bib = files.get(bib_name)
        if bib is None:
            missing_bib_resources.append(bib_name)
            continue
        bib_parts.append(bib)

    result = extract_latex_biblatex_apparatus(
        tex,
        "\n\n".join(bib_parts),
        source_kind=source_kind,
        source_ref={
            **source_ref,
            "tex_path": tex_name,
            "bib_paths": list(bib_names),
        },
    )
    diagnostics = dict(result.diagnostics)
    latex_diag = dict(diagnostics.get("latex_biblatex") or {})
    if missing_bib_resources:
        latex_diag["missing_bib_resources"] = missing_bib_resources
        diagnostics["latex_biblatex"] = latex_diag
        return LatexBiblatexApparatus(
            status="partial" if result.items else "empty",
            items=result.items,
            edges=result.edges,
            diagnostics=diagnostics,
        )
    return result


def extract_latex_biblatex_apparatus(
    tex: str,
    bib: str,
    *,
    source_kind: str,
    source_ref: dict[str, object],
) -> LatexBiblatexApparatus:
    source = _strip_latex_comments(tex)
    markers = _citation_markers(source)
    footnotes = _footnotes(source)
    bib_entries = _bib_entries_by_key(bib)
    cited_keys = _ordered_unique(key for marker in markers for key in marker.keys)
    missing_keys = [key for key in cited_keys if key not in bib_entries]
    cited_entries = [bib_entries[key] for key in cited_keys if key in bib_entries]

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    target_key_by_citation_key: dict[str, str] = {}

    for target_index, entry in enumerate(cited_entries):
        target_key = f"{source_kind}:latex-bibliography-target:{_stable_token(entry.key)}"
        target_key_by_citation_key[entry.key] = target_key
        body_text = _bib_entry_text(entry)
        items.append(
            {
                "stable_key": target_key,
                "kind": "bibliography_entry",
                "label": entry.key,
                "body_text": body_text,
                "body_html_sanitized": None,
                "confidence": "exact",
                "extraction_method": "latex_biblatex_bibliography",
                "source_ref": {
                    **source_ref,
                    "entry_type": entry.entry_type,
                    "citation_key": entry.key,
                },
                "sort_key": f"bibliography.{target_index:06d}.target",
                "_locator_text": "",
            }
        )

    for marker in markers:
        marker_key = (
            f"{source_kind}:latex-bibliography-ref:"
            f"{marker.ordinal:06d}:{_stable_token(','.join(marker.keys))}"
        )
        marker_source_ref = {
            **source_ref,
            "command": marker.command,
            "citation_keys": list(marker.keys),
        }
        items.append(
            {
                "stable_key": marker_key,
                "kind": "bibliography_ref",
                "label": _citation_marker_label(marker),
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": "exact",
                "extraction_method": "latex_biblatex_citation",
                "source_ref": marker_source_ref,
                "sort_key": f"{marker.sort_key}.marker",
                "_locator_text": "",
            }
        )
        for key_index, citation_key in enumerate(marker.keys):
            target_key = target_key_by_citation_key.get(citation_key)
            if target_key is None:
                continue
            edge_source_ref = {
                **marker_source_ref,
                "citation_key": citation_key,
            }
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}:{key_index:03d}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": "exact",
                    "extraction_method": "latex_biblatex_citation",
                    "source_ref": edge_source_ref,
                    "sort_key": f"{marker.sort_key}.edge.{key_index:03d}",
                }
            )

    for footnote in footnotes:
        items.append(
            {
                "stable_key": f"{source_kind}:latex-footnote:{footnote.ordinal:06d}",
                "kind": "footnote",
                "label": footnote.label,
                "body_text": footnote.body_text,
                "body_html_sanitized": None,
                "confidence": "exact",
                "extraction_method": "latex_footnote",
                "source_ref": {
                    **source_ref,
                    "command": footnote.command,
                    "ordinal": footnote.ordinal,
                },
                "sort_key": f"{footnote.sort_key}.target",
                "_locator_text": "",
            }
        )

    status = "empty"
    if items and missing_keys:
        status = "partial"
    elif items:
        status = "ready"
    return LatexBiblatexApparatus(
        status=status,
        items=items,
        edges=edges,
        diagnostics={
            "latex_biblatex": {
                "status": "missing_citation_keys" if missing_keys else status,
                "citation_marker_count": len(markers),
                "citation_edge_count": len(edges),
                "cited_bibliography_entry_count": len(cited_entries),
                "bib_entry_count": len(bib_entries),
                "uncited_bib_entry_count": len(set(bib_entries) - set(cited_keys)),
                "footnote_count": len(footnotes),
                "missing_citation_keys": missing_keys,
            }
        },
    )


def _source_archive_text_files(
    source_bytes: bytes,
    *,
    safety_cfg: LatexSourceArchiveSafetyConfig | None = None,
) -> dict[str, str]:
    cfg = safety_cfg or _default_source_archive_safety_config()
    files: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r:*") as archive:
        total_uncompressed = 0
        seen_names: set[str] = set()
        entry_count = 0
        for member in archive:
            entry_count += 1
            if entry_count > cfg.max_entries:
                raise LatexSourceArchiveUnsafe(
                    "too_many_entries",
                    f"Source archive has more than {cfg.max_entries} entries",
                )
            name = _safe_source_archive_name(member.name)
            if name in seen_names:
                raise LatexSourceArchiveUnsafe(
                    "duplicate_path",
                    f"Duplicate path in source archive: {name}",
                )
            seen_names.add(name)

            if member.isdir():
                continue
            if not member.isfile():
                raise LatexSourceArchiveUnsafe(
                    "unsupported_member_type",
                    f"Unsupported member type in source archive: {name}",
                )
            if member.size > cfg.max_single_entry_uncompressed_bytes:
                raise LatexSourceArchiveUnsafe(
                    "single_entry_too_large",
                    (
                        f"Entry '{name}' uncompressed size {member.size} exceeds limit "
                        f"{cfg.max_single_entry_uncompressed_bytes}"
                    ),
                )
            total_uncompressed += int(member.size)
            if total_uncompressed > cfg.max_total_uncompressed_bytes:
                raise LatexSourceArchiveUnsafe(
                    "total_uncompressed_too_large",
                    (
                        f"Total uncompressed source archive size {total_uncompressed} "
                        f"exceeds limit {cfg.max_total_uncompressed_bytes}"
                    ),
                )

            if member.size > _MAX_SOURCE_FILE_BYTES:
                continue
            if not name.lower().endswith((".tex", ".bib")):
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            files[name] = extracted.read().decode("utf-8", errors="replace")
        _check_source_archive_compression_ratio(
            source_bytes,
            total_uncompressed,
            cfg.max_compression_ratio,
        )
    return files


def _default_source_archive_safety_config() -> LatexSourceArchiveSafetyConfig:
    settings = get_settings()
    return LatexSourceArchiveSafetyConfig(
        max_entries=settings.max_latex_source_archive_entries,
        max_total_uncompressed_bytes=settings.max_latex_source_archive_total_uncompressed_bytes,
        max_single_entry_uncompressed_bytes=(
            settings.max_latex_source_archive_single_entry_uncompressed_bytes
        ),
        max_compression_ratio=settings.max_latex_source_archive_compression_ratio,
    )


def _safe_source_archive_name(raw_name: str) -> str:
    if "\x00" in raw_name:
        raise LatexSourceArchiveUnsafe(
            "nul_path",
            "NUL byte in source archive path",
        )
    if "\\" in raw_name:
        raise LatexSourceArchiveUnsafe(
            "backslash_path",
            f"Backslash path in source archive: {raw_name}",
        )
    if not raw_name:
        raise LatexSourceArchiveUnsafe("empty_path", "Empty path in source archive")
    name = raw_name
    if name.startswith("/"):
        raise LatexSourceArchiveUnsafe(
            "absolute_path",
            f"Absolute path in source archive: {raw_name}",
        )
    if len(name) > 1 and name[1] == ":":
        raise LatexSourceArchiveUnsafe(
            "drive_qualified_path",
            f"Drive-qualified path in source archive: {raw_name}",
        )
    parts: list[str] = []
    for part in name.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise LatexSourceArchiveUnsafe(
                "path_traversal",
                f"Path traversal in source archive: {raw_name}",
            )
        parts.append(part)
    if not parts:
        raise LatexSourceArchiveUnsafe(
            "empty_path",
            f"Empty path in source archive: {raw_name}",
        )
    return "/".join(parts)


def _check_source_archive_compression_ratio(
    source_bytes: bytes,
    total_uncompressed: int,
    max_compression_ratio: int,
) -> None:
    compressed_bytes = max(len(source_bytes), 1)
    ratio = total_uncompressed / compressed_bytes
    if ratio > max_compression_ratio:
        raise LatexSourceArchiveUnsafe(
            "compression_ratio_too_high",
            (f"Source archive compression ratio {ratio:.1f} exceeds limit {max_compression_ratio}"),
        )


def _primary_tex_file(files: Mapping[str, str]) -> tuple[str, str]:
    candidates = [
        (name, body)
        for name, body in files.items()
        if name.lower().endswith(".tex") and "\\begin{document}" in body
    ]
    if not candidates:
        raise ValueError("LaTeX source archive does not contain a primary document")
    return sorted(candidates, key=lambda item: item[0])[0]


def _bib_resource_names(tex: str) -> tuple[str, ...]:
    names: list[str] = []
    for match in re.finditer(r"\\(?:addbibresource|bibliography)\s*\{([^{}]+)\}", tex):
        for raw_name in match.group(1).split(","):
            name = raw_name.strip()
            if not name:
                continue
            if not name.lower().endswith(".bib"):
                name = f"{name}.bib"
            names.append(name)
    return tuple(_ordered_unique(names))


def _citation_markers(tex: str) -> list[LatexCitationMarker]:
    markers: list[LatexCitationMarker] = []
    for match in re.finditer(r"\\([A-Za-z]+)\*?", tex):
        command = match.group(1)
        if command not in _CITATION_COMMANDS:
            continue
        parsed = _latex_command_argument(tex, match.end())
        if parsed is None:
            continue
        raw, keys_body, end = parsed
        keys = tuple(key.strip() for key in keys_body.split(",") if key.strip())
        if not keys:
            continue
        markers.append(
            LatexCitationMarker(
                ordinal=len(markers),
                command=command,
                keys=keys,
                raw=tex[match.start() : end],
                sort_key=f"citation.{match.start():09d}.{len(markers):06d}",
            )
        )
    return markers


def _footnotes(tex: str) -> list[LatexFootnote]:
    footnotes: list[LatexFootnote] = []
    for match in re.finditer(r"\\([A-Za-z]+)\*?", tex):
        command = match.group(1)
        if command not in _FOOTNOTE_COMMANDS:
            continue
        pos = _skip_spaces(tex, match.end())
        label: str | None = None
        if pos < len(tex) and tex[pos] == "[":
            optional = _balanced_group(tex, pos, "[", "]")
            if optional is None:
                continue
            label, pos = optional
        pos = _skip_spaces(tex, pos)
        if pos >= len(tex) or tex[pos] != "{":
            continue
        body = _balanced_group(tex, pos, "{", "}")
        if body is None:
            continue
        body_text = _latex_text_to_plain(body[0])
        if not body_text:
            continue
        footnotes.append(
            LatexFootnote(
                ordinal=len(footnotes),
                command=command,
                label=label or str(len(footnotes) + 1),
                body_text=body_text,
                sort_key=f"footnote.{match.start():09d}.{len(footnotes):06d}",
            )
        )
    return footnotes


def _latex_command_argument(tex: str, pos: int) -> tuple[str, str, int] | None:
    start = pos
    pos = _skip_spaces(tex, pos)
    while pos < len(tex) and tex[pos] == "[":
        optional = _balanced_group(tex, pos, "[", "]")
        if optional is None:
            return None
        _, pos = optional
        pos = _skip_spaces(tex, pos)
    if pos >= len(tex) or tex[pos] != "{":
        return None
    required = _balanced_group(tex, pos, "{", "}")
    if required is None:
        return None
    return tex[start : required[1]], required[0], required[1]


def _bib_entries_by_key(bib: str) -> dict[str, BibEntry]:
    entries: dict[str, BibEntry] = {}
    pos = 0
    while True:
        at = bib.find("@", pos)
        if at < 0:
            break
        match = re.match(r"@([A-Za-z]+)\s*\{", bib[at:])
        if match is None:
            pos = at + 1
            continue
        entry_type = match.group(1).lower()
        body_start = at + match.end() - 1
        balanced = _balanced_group(bib, body_start, "{", "}")
        if balanced is None:
            pos = body_start + 1
            continue
        body, end = balanced
        key, fields = _parse_bib_entry_body(body)
        if key:
            entries[key] = BibEntry(key=key, entry_type=entry_type, fields=fields)
        pos = end
    return entries


def _parse_bib_entry_body(body: str) -> tuple[str, dict[str, str]]:
    if "," not in body:
        return "", {}
    key, rest = body.split(",", 1)
    fields: dict[str, str] = {}
    pos = 0
    while pos < len(rest):
        match = re.search(r"([A-Za-z][A-Za-z0-9_-]*)\s*=", rest[pos:])
        if match is None:
            break
        name = match.group(1).lower()
        value_start = pos + match.end()
        value, pos = _bib_value(rest, value_start)
        if value:
            fields[name] = _latex_text_to_plain(value)
    return key.strip(), fields


def _bib_value(text: str, pos: int) -> tuple[str, int]:
    pos = _skip_spaces(text, pos)
    if pos >= len(text):
        return "", pos
    if text[pos] == "{":
        balanced = _balanced_group(text, pos, "{", "}")
        if balanced is None:
            return "", pos + 1
        value, end = balanced
        return value, _skip_field_separator(text, end)
    if text[pos] == '"':
        end = pos + 1
        escaped = False
        while end < len(text):
            char = text[end]
            if char == '"' and not escaped:
                break
            escaped = char == "\\" and not escaped
            if char != "\\":
                escaped = False
            end += 1
        return text[pos + 1 : end], _skip_field_separator(text, min(end + 1, len(text)))
    end = pos
    while end < len(text) and text[end] != ",":
        end += 1
    return text[pos:end].strip(), _skip_field_separator(text, end)


def _skip_field_separator(text: str, pos: int) -> int:
    pos = _skip_spaces(text, pos)
    if pos < len(text) and text[pos] == ",":
        return pos + 1
    return pos


def _bib_entry_text(entry: BibEntry) -> str:
    fields = entry.fields
    parts = [
        value
        for value in (
            fields.get("title"),
            fields.get("author"),
            fields.get("journal") or fields.get("booktitle"),
            fields.get("publisher"),
            fields.get("year") or fields.get("date"),
            fields.get("doi"),
            fields.get("url"),
        )
        if value
    ]
    return normalize_whitespace(". ".join(parts)) or entry.key


def _citation_marker_label(marker: LatexCitationMarker) -> str:
    if len(marker.keys) == 1:
        return marker.keys[0]
    return ", ".join(marker.keys)


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


def _latex_text_to_plain(value: str) -> str:
    text = value
    text = text.replace("~", " ")
    text = text.replace(r"\,", " ")
    text = text.replace(r"\&", "&")
    text = text.replace(r"\'", "")
    text = text.replace(r"\"", "")
    text = re.sub(r"\\[A-Za-z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}", r"\1", text)
    text = re.sub(r"\\[A-Za-z]+\*?", "", text)
    text = text.replace("{", "").replace("}", "")
    text = text.replace("\\", "")
    text = re.sub(r"\s+([,.;:!?])", r"\1", normalize_whitespace(text))
    return text.strip()


def _ordered_unique(values) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _stable_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return token[:96] or "item"
