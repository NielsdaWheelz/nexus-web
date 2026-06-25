"""Typed local-vault sync file contracts."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

VAULT_FILE_CONTENT_BYTE_LIMIT = 1_000_000
_HANDLE_RE = re.compile(r"^(med|frag|hl|page)_([0-9a-f]{32})$")
_PAGE_PATH_HANDLE_RE = re.compile(r"--(page_[0-9a-f]{32})\.md$")


@dataclass(frozen=True, slots=True)
class EditableVaultFile:
    path: str
    content: str


@dataclass(frozen=True, slots=True)
class VaultFileParseFailure:
    path: str
    content: str
    message: str


@dataclass(frozen=True, slots=True)
class NewHighlightFile:
    path: str
    content: str
    body: str
    media_id: UUID
    color: str
    fragment_id: UUID
    start_offset: int
    end_offset: int


@dataclass(frozen=True, slots=True)
class ExistingHighlightFile:
    path: str
    content: str
    body: str
    highlight_id: UUID
    media_id: UUID
    color: str
    server_updated_at: str
    deleted: bool
    selector_kind: Literal["fragment_offsets", "pdf_page_geometry"]
    exact: str
    prefix: str
    suffix: str
    fragment_id: UUID | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    page: int | None = None


@dataclass(frozen=True, slots=True)
class NewPageFile:
    path: str
    content: str
    body: str
    title: str


@dataclass(frozen=True, slots=True)
class ExistingPageFile:
    path: str
    content: str
    body: str
    page_id: UUID
    title: str
    server_updated_at: str
    deleted: bool


ParsedVaultFile = NewHighlightFile | ExistingHighlightFile | NewPageFile | ExistingPageFile


def parse_editable_vault_path(raw_path: str) -> str:
    path = raw_path
    if (
        "\\" in path
        or path.startswith("/")
        or path.endswith(".conflict.md")
        or path.endswith("/.md")
        or not re.fullmatch(r"(Highlights|Pages)/[^/]+\.md", path)
        or ".." in path.split("/")
    ):
        raise ValueError(
            "Editable vault uploads must be Markdown files under Highlights/ or Pages/"
        )
    return path


def parse_vault_markdown_file(file: EditableVaultFile) -> ParsedVaultFile | VaultFileParseFailure:
    try:
        path = parse_editable_vault_path(file.path)
    except ValueError as exc:
        return VaultFileParseFailure(file.path, file.content, str(exc))
    content = file.content
    if len(content.encode("utf-8")) > VAULT_FILE_CONTENT_BYTE_LIMIT:
        return VaultFileParseFailure(
            path, content, "Vault file content exceeds 1,000,000 UTF-8 bytes"
        )
    try:
        metadata, body = _read_frontmatter(content)
    except ValueError as exc:
        return VaultFileParseFailure(path, content, str(exc))

    nexus_type = metadata.get("nexus_type")
    if path.startswith("Highlights/"):
        if nexus_type != "highlight":
            return VaultFileParseFailure(
                path, content, "Vault highlight file needs nexus_type highlight"
            )
        return _parse_highlight_file(path, content, body, metadata)
    if path.startswith("Pages/"):
        if nexus_type != "page":
            return VaultFileParseFailure(path, content, "Vault page file needs nexus_type page")
        return _parse_page_file(path, content, body, metadata)
    return VaultFileParseFailure(
        path, content, "Vault uploads must be highlight or page Markdown files"
    )


def format_vault_handle(prefix: Literal["med", "frag", "hl", "page"], value: UUID) -> str:
    return f"{prefix}_{value.hex}"


def _parse_highlight_file(
    path: str, content: str, body: str, metadata: dict[str, object]
) -> NewHighlightFile | ExistingHighlightFile | VaultFileParseFailure:
    unknown = set(metadata) - {
        "nexus_type",
        "highlight_handle",
        "media_handle",
        "color",
        "server_updated_at",
        "deleted",
        "exact",
        "prefix",
        "suffix",
        "selector_kind",
        "fragment_handle",
        "start_offset",
        "end_offset",
        "page",
    }
    if unknown:
        return VaultFileParseFailure(
            path, content, f"Vault highlight metadata has unknown field {sorted(unknown)[0]}"
        )

    path_handle = _highlight_handle_from_path(path)
    handle = metadata.get("highlight_handle")
    if path_handle is None:
        if handle is not None:
            return VaultFileParseFailure(
                path, content, "Vault new highlight metadata must not include highlight_handle"
            )
        return _parse_new_highlight(path, content, body, metadata)
    if not isinstance(handle, str):
        return VaultFileParseFailure(
            path, content, "Vault highlight metadata is missing highlight_handle"
        )
    try:
        highlight_id = _parse_handle(handle, "hl")
    except ValueError as exc:
        return VaultFileParseFailure(path, content, str(exc))
    if handle != path_handle:
        return VaultFileParseFailure(path, content, "Vault highlight handle does not match path")
    return _parse_existing_highlight(path, content, body, metadata, highlight_id)


def _parse_new_highlight(
    path: str, content: str, body: str, metadata: dict[str, object]
) -> NewHighlightFile | VaultFileParseFailure:
    if "highlight_handle" in metadata:
        return VaultFileParseFailure(
            path, content, "Vault new highlight metadata must not include highlight_handle"
        )
    if "server_updated_at" in metadata:
        return VaultFileParseFailure(
            path, content, "Vault new highlight metadata must not include server_updated_at"
        )
    if metadata.get("selector_kind") != "fragment_offsets":
        return VaultFileParseFailure(
            path, content, "Vault highlight metadata has invalid selector_kind"
        )
    unknown = set(metadata) - {
        "nexus_type",
        "media_handle",
        "color",
        "deleted",
        "selector_kind",
        "fragment_handle",
        "start_offset",
        "end_offset",
    }
    if unknown:
        return VaultFileParseFailure(
            path, content, f"Vault new highlight metadata has unknown field {sorted(unknown)[0]}"
        )
    if metadata.get("deleted") is not False:
        return VaultFileParseFailure(
            path, content, "Vault new highlight metadata requires deleted false"
        )
    color = _required_string(metadata, "color", "highlight", path, content)
    if isinstance(color, VaultFileParseFailure):
        return color
    media_id = _required_handle(metadata, "media_handle", "med", "highlight", path, content)
    if isinstance(media_id, VaultFileParseFailure):
        return media_id
    selector = _fragment_selector(metadata, "highlight", path, content)
    if isinstance(selector, VaultFileParseFailure):
        return selector
    fragment_id, start_offset, end_offset = selector
    return NewHighlightFile(
        path=path,
        content=content,
        body=body,
        media_id=media_id,
        color=color,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
    )


def _parse_existing_highlight(
    path: str,
    content: str,
    body: str,
    metadata: dict[str, object],
    highlight_id: UUID,
) -> ExistingHighlightFile | VaultFileParseFailure:
    media_id = _required_handle(metadata, "media_handle", "med", "highlight", path, content)
    if isinstance(media_id, VaultFileParseFailure):
        return media_id
    color = _required_string(metadata, "color", "highlight", path, content)
    if isinstance(color, VaultFileParseFailure):
        return color
    server_updated_at = _required_string(metadata, "server_updated_at", "highlight", path, content)
    if isinstance(server_updated_at, VaultFileParseFailure):
        return server_updated_at
    deleted = _required_bool(metadata, "deleted", "highlight", path, content)
    if isinstance(deleted, VaultFileParseFailure):
        return deleted
    exact = _required_present_string(metadata, "exact", "highlight", path, content)
    if isinstance(exact, VaultFileParseFailure):
        return exact
    prefix = _required_present_string(metadata, "prefix", "highlight", path, content)
    if isinstance(prefix, VaultFileParseFailure):
        return prefix
    suffix = _required_present_string(metadata, "suffix", "highlight", path, content)
    if isinstance(suffix, VaultFileParseFailure):
        return suffix

    selector_kind = metadata.get("selector_kind")
    if selector_kind == "fragment_offsets":
        unknown = set(metadata) - {
            "nexus_type",
            "highlight_handle",
            "media_handle",
            "color",
            "server_updated_at",
            "deleted",
            "exact",
            "prefix",
            "suffix",
            "selector_kind",
            "fragment_handle",
            "start_offset",
            "end_offset",
        }
        if unknown:
            return VaultFileParseFailure(
                path,
                content,
                f"Vault highlight fragment_offsets metadata has unknown field {sorted(unknown)[0]}",
            )
        selector = _fragment_selector(metadata, "highlight", path, content)
        if isinstance(selector, VaultFileParseFailure):
            return selector
        fragment_id, start_offset, end_offset = selector
        return ExistingHighlightFile(
            path=path,
            content=content,
            body=body,
            highlight_id=highlight_id,
            media_id=media_id,
            color=color,
            server_updated_at=server_updated_at,
            deleted=deleted,
            selector_kind="fragment_offsets",
            exact=exact,
            prefix=prefix,
            suffix=suffix,
            fragment_id=fragment_id,
            start_offset=start_offset,
            end_offset=end_offset,
        )
    if selector_kind == "pdf_page_geometry":
        unknown = set(metadata) - {
            "nexus_type",
            "highlight_handle",
            "media_handle",
            "color",
            "server_updated_at",
            "deleted",
            "exact",
            "prefix",
            "suffix",
            "selector_kind",
            "page",
        }
        if unknown:
            return VaultFileParseFailure(
                path,
                content,
                f"Vault highlight pdf_page_geometry metadata has unknown field {sorted(unknown)[0]}",
            )
        page = _required_int(metadata, "page", "highlight", path, content)
        if isinstance(page, VaultFileParseFailure):
            return page
        return ExistingHighlightFile(
            path=path,
            content=content,
            body=body,
            highlight_id=highlight_id,
            media_id=media_id,
            color=color,
            server_updated_at=server_updated_at,
            deleted=deleted,
            selector_kind="pdf_page_geometry",
            exact=exact,
            prefix=prefix,
            suffix=suffix,
            page=page,
        )
    return VaultFileParseFailure(
        path, content, "Vault highlight metadata has invalid selector_kind"
    )


def _parse_page_file(
    path: str, content: str, body: str, metadata: dict[str, object]
) -> NewPageFile | ExistingPageFile | VaultFileParseFailure:
    unknown = set(metadata) - {"nexus_type", "page_handle", "title", "server_updated_at", "deleted"}
    if unknown:
        return VaultFileParseFailure(
            path, content, f"Vault page metadata has unknown field {sorted(unknown)[0]}"
        )

    path_handle = _page_handle_from_path(path)
    handle = metadata.get("page_handle")
    if path_handle is None:
        if handle is not None:
            return VaultFileParseFailure(
                path, content, "Vault new page metadata must not include page_handle"
            )
        if "server_updated_at" in metadata:
            return VaultFileParseFailure(
                path, content, "Vault new page metadata must not include server_updated_at"
            )
        if metadata.get("deleted") is not False:
            return VaultFileParseFailure(
                path, content, "Vault new page metadata requires deleted false"
            )
        title = _required_string(metadata, "title", "page", path, content)
        if isinstance(title, VaultFileParseFailure):
            return title
        return NewPageFile(path=path, content=content, body=body, title=title)

    if not isinstance(handle, str):
        return VaultFileParseFailure(path, content, "Vault page metadata is missing page_handle")
    try:
        page_id = _parse_handle(handle, "page")
    except ValueError as exc:
        return VaultFileParseFailure(path, content, str(exc))
    if handle != path_handle:
        return VaultFileParseFailure(path, content, "Vault page handle does not match path")

    title = _required_string(metadata, "title", "page", path, content)
    if isinstance(title, VaultFileParseFailure):
        return title
    server_updated_at = _required_string(metadata, "server_updated_at", "page", path, content)
    if isinstance(server_updated_at, VaultFileParseFailure):
        return server_updated_at
    deleted = _required_bool(metadata, "deleted", "page", path, content)
    if isinstance(deleted, VaultFileParseFailure):
        return deleted
    return ExistingPageFile(
        path=path,
        content=content,
        body=body,
        page_id=page_id,
        title=title,
        server_updated_at=server_updated_at,
        deleted=deleted,
    )


def _read_frontmatter(text_content: str) -> tuple[dict[str, object], str]:
    if not text_content.startswith("---\n"):
        raise ValueError("Vault file is missing frontmatter")
    end = text_content.find("\n---\n", 4)
    if end == -1:
        raise ValueError("Vault file frontmatter is not closed")
    metadata: dict[str, object] = {}
    lines = text_content[4:end].splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip():
            continue
        if ":" not in line:
            raise ValueError("Vault frontmatter line is invalid")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if not key:
            raise ValueError("Vault frontmatter key is empty")
        if key in metadata:
            raise ValueError(f"Vault frontmatter has duplicate field {key}")
        value = raw_value.strip()
        if value == "|":
            block_lines = []
            while i < len(lines) and (lines[i].startswith("  ") or not lines[i].strip()):
                block_lines.append(lines[i][2:] if lines[i].startswith("  ") else "")
                i += 1
            metadata[key] = "\n".join(block_lines).rstrip("\n")
        elif value in {"true", "false"}:
            metadata[key] = value == "true"
        elif value.startswith('"'):
            try:
                metadata[key] = json.loads(value)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Vault frontmatter field {key} is invalid JSON string") from exc
        elif re.fullmatch(r"-?\d+", value):
            metadata[key] = int(value)
        else:
            raise ValueError(
                f"Vault frontmatter field {key} must be a quoted string, boolean, integer, or block value"
            )
    return metadata, text_content[end + 5 :]


def _highlight_handle_from_path(path: str) -> str | None:
    filename = path.removeprefix("Highlights/")
    handle = filename.removesuffix(".md")
    return handle if _HANDLE_RE.fullmatch(handle) and handle.startswith("hl_") else None


def _page_handle_from_path(path: str) -> str | None:
    match = _PAGE_PATH_HANDLE_RE.search(path)
    return None if match is None else match.group(1)


def _parse_handle(raw: str, prefix: Literal["med", "frag", "hl", "page"]) -> UUID:
    match = _HANDLE_RE.fullmatch(raw)
    if match is None:
        raise ValueError(f"Invalid {prefix} handle")
    if match.group(1) != prefix:
        raise ValueError(f"Invalid {prefix} handle")
    return UUID(hex=match.group(2))


def _required_handle(
    metadata: dict[str, object],
    field: str,
    prefix: Literal["med", "frag", "hl", "page"],
    label: str,
    path: str,
    content: str,
) -> UUID | VaultFileParseFailure:
    value = _required_string(metadata, field, label, path, content)
    if isinstance(value, VaultFileParseFailure):
        return value
    try:
        return _parse_handle(value, prefix)
    except ValueError as exc:
        return VaultFileParseFailure(path, content, str(exc))


def _required_string(
    metadata: dict[str, object], field: str, label: str, path: str, content: str
) -> str | VaultFileParseFailure:
    value = metadata.get(field)
    if not isinstance(value, str) or not value.strip():
        return VaultFileParseFailure(path, content, f"Vault {label} metadata is missing {field}")
    return value.strip()


def _required_present_string(
    metadata: dict[str, object], field: str, label: str, path: str, content: str
) -> str | VaultFileParseFailure:
    value = metadata.get(field)
    if not isinstance(value, str):
        return VaultFileParseFailure(path, content, f"Vault {label} metadata is missing {field}")
    return value


def _required_bool(
    metadata: dict[str, object], field: str, label: str, path: str, content: str
) -> bool | VaultFileParseFailure:
    value = metadata.get(field)
    if not isinstance(value, bool):
        return VaultFileParseFailure(path, content, f"Vault {label} metadata is missing {field}")
    return value


def _required_int(
    metadata: dict[str, object], field: str, label: str, path: str, content: str
) -> int | VaultFileParseFailure:
    value = metadata.get(field)
    if not isinstance(value, int):
        return VaultFileParseFailure(path, content, f"Vault {label} metadata is missing {field}")
    return value


def _fragment_selector(
    metadata: dict[str, object], label: str, path: str, content: str
) -> tuple[UUID, int, int] | VaultFileParseFailure:
    if metadata.get("selector_kind") != "fragment_offsets":
        return VaultFileParseFailure(
            path, content, f"Vault {label} metadata has invalid selector_kind"
        )
    fragment_id = _required_handle(metadata, "fragment_handle", "frag", label, path, content)
    if isinstance(fragment_id, VaultFileParseFailure):
        return fragment_id
    start_offset = _required_int(metadata, "start_offset", label, path, content)
    if isinstance(start_offset, VaultFileParseFailure):
        return start_offset
    end_offset = _required_int(metadata, "end_offset", label, path, content)
    if isinstance(end_offset, VaultFileParseFailure):
        return end_offset
    return fragment_id, start_offset, end_offset
