"""EPUB extraction domain service.

Deterministic extraction of chapter fragments, TOC snapshots, title, and
internal assets from EPUB archives.  No route bindings; invoked by task
wrappers (PR-02) and orchestrated by lifecycle endpoints (PR-03).

Reuses existing sanitization/canonicalization/fragment-block primitives.
"""

from __future__ import annotations

import hashlib
import io
import posixpath
import re
import time
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import quote, unquote, urlparse
from uuid import UUID
from xml.etree import ElementTree as ET

from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import EpubTocNode, Fragment, Media
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.sanitize_html import IMAGE_PROXY_URL

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Public result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EpubExtractionResult:
    status: str = "success"
    chapter_count: int = 0
    toc_node_count: int = 0
    asset_count: int = 0
    title: str | None = None


@dataclass(frozen=True)
class EpubExtractionError:
    status: str = "failed"
    error_code: str = ""
    error_message: str = ""
    terminal: bool = False


# ---------------------------------------------------------------------------
# Internal spec types
# ---------------------------------------------------------------------------

_READABLE_MEDIA_TYPES = frozenset(
    {
        "application/xhtml+xml",
        "application/xml",
        "text/html",
        "text/xml",
    }
)

_OPF_MEDIA_TYPES = frozenset({"application/oebps-package+xml"})

_NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ASSET_KEY_SAFE = re.compile(r"^[a-zA-Z0-9_./-]+$")

# Tags to strip entirely from EPUB chapter content (before sanitization)
_STRIP_TAGS = frozenset({"head", "script", "style", "meta", "link", "base"})


@dataclass
class _ChapterSpec:
    spine_idx: int
    manifest_id: str
    href: str
    media_type: str
    raw_html: str


@dataclass
class _TocNodeSpec:
    node_id: str
    parent_node_id: str | None
    label: str
    href: str | None
    fragment_idx: int | None
    depth: int
    order_key: str


@dataclass
class _AssetEntry:
    epub_path: str
    asset_key: str
    content: bytes
    content_type: str


@dataclass
class _ArchiveSafetyConfig:
    max_entries: int
    max_total_uncompressed_bytes: int
    max_single_entry_uncompressed_bytes: int
    max_compression_ratio: int
    max_parse_time_ms: int


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def extract_epub_artifacts(
    db: Session,
    media_id: UUID,
    storage_client: StorageClientBase,
    *,
    now: datetime | None = None,
) -> EpubExtractionResult | EpubExtractionError:
    """Deterministic EPUB extraction.  Single-transaction artifact write.

    Does NOT mutate media.processing_status (owned by PR-03).
    """
    if now is None:
        now = datetime.now(UTC)

    settings = get_settings()
    safety_cfg = _ArchiveSafetyConfig(
        max_entries=settings.max_epub_archive_entries,
        max_total_uncompressed_bytes=settings.max_epub_archive_total_uncompressed_bytes,
        max_single_entry_uncompressed_bytes=settings.max_epub_archive_single_entry_uncompressed_bytes,
        max_compression_ratio=settings.max_epub_archive_compression_ratio,
        max_parse_time_ms=settings.max_epub_archive_parse_time_ms,
    )

    media = db.get(Media, media_id)
    if media is None:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message="Media row not found",
        )

    media_file = media.media_file
    if media_file is None:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message="No media_file record for EPUB",
        )

    # ---- read bytes from storage -------------------------------------------
    try:
        epub_bytes = b"".join(storage_client.stream_object(media_file.storage_path))
    except Exception as exc:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message=f"Failed to read EPUB from storage: {exc}",
        )

    # ---- archive safety gate -----------------------------------------------
    safety_err = _check_archive_safety(epub_bytes, safety_cfg)
    if safety_err is not None:
        return safety_err

    # ---- parse OPF ---------------------------------------------------------
    t_start = time.monotonic()
    try:
        zf = zipfile.ZipFile(io.BytesIO(epub_bytes))
    except (zipfile.BadZipFile, Exception) as exc:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message=f"Invalid ZIP: {exc}",
        )

    try:
        opf_path = _find_opf_path(zf)
        if opf_path is None:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message="Cannot locate OPF rootfile",
            )

        opf_dir = posixpath.dirname(opf_path)
        opf_tree = _parse_xml_entry(zf, opf_path)
        if opf_tree is None:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message="Failed to parse OPF",
            )

        manifest = _parse_manifest(opf_tree, opf_dir)
        spine_idrefs = _parse_spine(opf_tree)

        # ---- title resolution ----------------------------------------------
        title = _resolve_title(opf_tree, media_file.storage_path)
        media.title = title
        media.updated_at = now

        # ---- extract readable chapters -------------------------------------
        chapter_specs = _collect_readable_chapters(zf, manifest, spine_idrefs)
        if not chapter_specs:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message="Zero readable chapters after extraction",
            )

        # ---- resource rewriting + asset collection -------------------------
        asset_entries: list[_AssetEntry] = []
        asset_key_map: dict[str, str] = {}  # epub_path -> asset_key

        for ch in chapter_specs:
            ch.raw_html = _rewrite_chapter_resources(
                ch.raw_html,
                ch.href,
                opf_dir,
                zf,
                media_id,
                manifest,
                asset_entries,
                asset_key_map,
            )

        # ---- sanitize + canonicalize + fragment creation --------------------
        fragments: list[Fragment] = []
        all_block_specs: list[tuple[int, list]] = []

        for contiguous_idx, ch in enumerate(chapter_specs):
            try:
                html_sanitized = _epub_sanitize(ch.raw_html)
            except Exception as exc:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_SANITIZATION_FAILED.value,
                    error_message=f"Sanitization failed for chapter idx {contiguous_idx}: {exc}",
                )

            try:
                canonical_text = generate_canonical_text(html_sanitized)
            except Exception as exc:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_SANITIZATION_FAILED.value,
                    error_message=f"Canonicalization failed for chapter idx {contiguous_idx}: {exc}",
                )

            if not canonical_text.strip():
                continue

            frag = Fragment(
                media_id=media_id,
                idx=contiguous_idx,
                html_sanitized=html_sanitized,
                canonical_text=canonical_text,
                created_at=now,
            )
            fragments.append(frag)
            block_specs = parse_fragment_blocks(canonical_text)
            all_block_specs.append((contiguous_idx, block_specs))

        # re-index fragments contiguously after potential empty-skip
        for new_idx, frag in enumerate(fragments):
            frag.idx = new_idx

        if not fragments:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message="Zero readable chapters after canonicalization",
            )

        # build href -> fragment_idx lookup
        href_to_frag_idx = _build_href_to_frag_idx(chapter_specs, fragments)

        # ---- TOC materialization -------------------------------------------
        toc_nodes = _materialize_toc(zf, opf_tree, opf_dir, manifest, href_to_frag_idx, media_id)

        # ---- check parse-time budget ---------------------------------------
        elapsed_ms = int((time.monotonic() - t_start) * 1000)
        if elapsed_ms > safety_cfg.max_parse_time_ms:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Parse time {elapsed_ms}ms exceeded limit {safety_cfg.max_parse_time_ms}ms",
                terminal=True,
            )

        # ---- atomic persistence --------------------------------------------
        for frag in fragments:
            db.add(frag)
        db.flush()

        for frag in fragments:
            idx = frag.idx
            matching = [bs for (cidx, bs) in all_block_specs if cidx == idx]
            if not matching:
                matching = [bs for (cidx, bs) in all_block_specs]
            if matching:
                insert_fragment_blocks(db, frag.id, matching[0])

        for tn in toc_nodes:
            db.add(
                EpubTocNode(
                    media_id=media_id,
                    node_id=tn.node_id,
                    parent_node_id=tn.parent_node_id,
                    label=tn.label,
                    href=tn.href,
                    fragment_idx=tn.fragment_idx,
                    depth=tn.depth,
                    order_key=tn.order_key,
                    created_at=now,
                )
            )

        db.flush()

    except Exception as exc:
        db.rollback()
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message=f"Extraction failed: {exc}",
        )
    finally:
        zf.close()

    # ---- persist assets to storage (after db flush, before commit) ---------
    persisted_assets = 0
    for ae in asset_entries:
        try:
            asset_storage_key = f"media/{media_id}/assets/{ae.asset_key}"
            storage_client.put_object(asset_storage_key, ae.content, ae.content_type)
            persisted_assets += 1
        except Exception:
            logger.warning(
                "epub_asset_upload_failed",
                media_id=str(media_id),
                asset_key=ae.asset_key,
            )

    return EpubExtractionResult(
        chapter_count=len(fragments),
        toc_node_count=len(toc_nodes),
        asset_count=persisted_assets,
        title=title,
    )


# ---------------------------------------------------------------------------
# Archive safety
# ---------------------------------------------------------------------------


def _check_archive_safety(
    data: bytes,
    cfg: _ArchiveSafetyConfig,
) -> EpubExtractionError | None:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, Exception) as exc:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
            error_message=f"Invalid archive: {exc}",
            terminal=True,
        )

    infos = zf.infolist()

    if len(infos) > cfg.max_entries:
        zf.close()
        return EpubExtractionError(
            error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
            error_message=f"Archive has {len(infos)} entries (limit {cfg.max_entries})",
            terminal=True,
        )

    total_uncompressed = 0
    for info in infos:
        # path safety: reject absolute, traversal, drive-qualified
        name = info.filename
        if name.startswith("/") or name.startswith("\\"):
            zf.close()
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Absolute path in archive: {name}",
                terminal=True,
            )
        if ".." in name.split("/"):
            zf.close()
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Path traversal in archive: {name}",
                terminal=True,
            )
        if len(name) > 1 and name[1] == ":":
            zf.close()
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Drive-qualified path in archive: {name}",
                terminal=True,
            )

        uncompressed = info.file_size
        compressed = info.compress_size

        if uncompressed > cfg.max_single_entry_uncompressed_bytes:
            zf.close()
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=(
                    f"Entry '{name}' uncompressed size {uncompressed} "
                    f"exceeds limit {cfg.max_single_entry_uncompressed_bytes}"
                ),
                terminal=True,
            )

        total_uncompressed += uncompressed

        if compressed > 0 and uncompressed / compressed > cfg.max_compression_ratio:
            zf.close()
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=(
                    f"Entry '{name}' compression ratio {uncompressed / compressed:.1f} "
                    f"exceeds limit {cfg.max_compression_ratio}"
                ),
                terminal=True,
            )

    if total_uncompressed > cfg.max_total_uncompressed_bytes:
        zf.close()
        return EpubExtractionError(
            error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
            error_message=(
                f"Total uncompressed {total_uncompressed} "
                f"exceeds limit {cfg.max_total_uncompressed_bytes}"
            ),
            terminal=True,
        )

    zf.close()
    return None


# ---------------------------------------------------------------------------
# OPF / Manifest / Spine parsing
# ---------------------------------------------------------------------------


def _find_opf_path(zf: zipfile.ZipFile) -> str | None:
    container = _parse_xml_entry(zf, "META-INF/container.xml")
    if container is None:
        return None
    rootfile = container.find(
        ".//container:rootfile[@media-type='application/oebps-package+xml']",
        _NS,
    )
    if rootfile is None:
        rootfile = container.find(".//container:rootfile", _NS)
    if rootfile is not None:
        return rootfile.get("full-path")
    return None


def _parse_xml_entry(zf: zipfile.ZipFile, path: str) -> ET.Element | None:
    try:
        raw = zf.read(path)
        return ET.fromstring(raw)
    except (KeyError, ET.ParseError, Exception):
        return None


def _parse_manifest(
    opf: ET.Element,
    opf_dir: str,
) -> dict[str, tuple[str, str]]:
    """Return {manifest_id: (resolved_href, media_type)}."""
    result: dict[str, tuple[str, str]] = {}
    for item in opf.findall(".//opf:manifest/opf:item", _NS):
        item_id = item.get("id", "")
        href = item.get("href", "")
        mtype = item.get("media-type", "")
        if item_id and href:
            resolved = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
            result[item_id] = (resolved, mtype)
    return result


def _parse_spine(opf: ET.Element) -> list[str]:
    refs: list[str] = []
    for itemref in opf.findall(".//opf:spine/opf:itemref", _NS):
        idref = itemref.get("idref", "")
        linear = itemref.get("linear", "yes")
        if idref and linear != "no":
            refs.append(idref)
    return refs


# ---------------------------------------------------------------------------
# Title resolution
# ---------------------------------------------------------------------------


def _resolve_title(opf: ET.Element, storage_path: str) -> str:
    # dc:title
    dc_title = opf.find(".//opf:metadata/dc:title", _NS)
    if dc_title is not None and dc_title.text and dc_title.text.strip():
        return _normalize_title(dc_title.text.strip())

    # <title> (non-namespaced fallback)
    for tag_path in [".//opf:metadata/title", ".//title"]:
        title_el = opf.find(tag_path, _NS)
        if title_el is not None and title_el.text and title_el.text.strip():
            return _normalize_title(title_el.text.strip())

    # filename sans extension
    filename = _filename_from_storage_path(storage_path)
    if filename:
        return _normalize_title(filename)

    return "Untitled EPUB"


def _normalize_title(raw: str) -> str:
    t = re.sub(r"\s+", " ", raw).strip()
    if not t:
        return "Untitled EPUB"
    return t[:255]


def _filename_from_storage_path(path: str) -> str:
    base = posixpath.basename(path)
    if "." in base:
        name = base.rsplit(".", 1)[0]
        name = name.strip()
        if name and name.lower() != "original":
            return name
    return ""


# ---------------------------------------------------------------------------
# Chapter extraction
# ---------------------------------------------------------------------------


def _collect_readable_chapters(
    zf: zipfile.ZipFile,
    manifest: dict[str, tuple[str, str]],
    spine_idrefs: list[str],
) -> list[_ChapterSpec]:
    chapters: list[_ChapterSpec] = []
    for spine_idx, idref in enumerate(spine_idrefs):
        entry = manifest.get(idref)
        if entry is None:
            continue
        href, mtype = entry
        if mtype not in _READABLE_MEDIA_TYPES:
            continue
        try:
            raw = zf.read(href).decode("utf-8", errors="replace")
        except (KeyError, Exception):
            continue
        raw = _strip_epub_wrappers(raw)
        if not raw.strip():
            continue
        chapters.append(
            _ChapterSpec(
                spine_idx=spine_idx,
                manifest_id=idref,
                href=href,
                media_type=mtype,
                raw_html=raw,
            )
        )
    return chapters


def _strip_epub_wrappers(html: str) -> str:
    """Extract <body> content from full XHTML document."""
    lower = html.lower()
    body_start = lower.find("<body")
    if body_start == -1:
        return html
    tag_end = lower.find(">", body_start)
    if tag_end == -1:
        return html

    body_close = lower.rfind("</body>")
    if body_close == -1:
        body_content = html[tag_end + 1 :]
    else:
        body_content = html[tag_end + 1 : body_close]

    return body_content


# ---------------------------------------------------------------------------
# Resource rewriting
# ---------------------------------------------------------------------------


def _rewrite_chapter_resources(
    html: str,
    chapter_href: str,
    opf_dir: str,
    zf: zipfile.ZipFile,
    media_id: UUID,
    manifest: dict[str, tuple[str, str]],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
) -> str:
    """Rewrite src/href in chapter HTML.

    - Internal resolvable assets -> /media/{media_id}/assets/{key}
    - External http(s) images -> image proxy
    - Unresolvable internal -> remove attribute (graceful degradation)
    """
    chapter_dir = posixpath.dirname(chapter_href)

    def _rewrite_attr(match: re.Match) -> str:
        attr_name = match.group(1)
        quote_char = match.group(2)
        raw_url = match.group(3)

        if not raw_url or raw_url.startswith("#"):
            return match.group(0)

        parsed = urlparse(raw_url)

        # external http(s) image
        if parsed.scheme in ("http", "https"):
            if attr_name == "src":
                encoded = quote(raw_url, safe="")
                return f"{attr_name}={quote_char}{IMAGE_PROXY_URL.format(encoded_url=encoded)}{quote_char}"
            return match.group(0)

        if parsed.scheme and parsed.scheme not in ("", "http", "https"):
            return f"{attr_name}={quote_char}{quote_char}"

        # internal reference
        decoded = unquote(raw_url)
        frag = parsed.fragment
        path_only = decoded.split("#")[0] if "#" in decoded else decoded
        resolved = posixpath.normpath(posixpath.join(chapter_dir, path_only))

        # check if it exists in the archive
        if resolved in asset_key_map:
            key = asset_key_map[resolved]
            rewritten = f"/media/{media_id}/assets/{key}"
            if frag:
                rewritten += f"#{frag}"
            return f"{attr_name}={quote_char}{rewritten}{quote_char}"

        # try to read from zip
        try:
            content = zf.read(resolved)
        except (KeyError, Exception):
            return f"{attr_name}={quote_char}{quote_char}"

        # derive asset key
        key = _derive_asset_key(resolved, asset_key_map)
        asset_key_map[resolved] = key

        # guess content type from manifest or extension
        ct = _guess_content_type(resolved, manifest)
        asset_entries.append(
            _AssetEntry(
                epub_path=resolved,
                asset_key=key,
                content=content,
                content_type=ct,
            )
        )

        rewritten = f"/media/{media_id}/assets/{key}"
        if frag:
            rewritten += f"#{frag}"
        return f"{attr_name}={quote_char}{rewritten}{quote_char}"

    html = re.sub(
        r"""(src|href)\s*=\s*(["'])(.*?)\2""",
        _rewrite_attr,
        html,
        flags=re.IGNORECASE,
    )
    return html


def _derive_asset_key(epub_path: str, existing: dict[str, str]) -> str:
    """Deterministic asset key from normalized EPUB path."""
    key = epub_path.lstrip("/")
    key = re.sub(r"[^a-zA-Z0-9_./-]", "_", key)
    if not key:
        key = "asset"

    if key not in existing.values():
        return key

    # collision: add hash suffix
    h = hashlib.sha256(epub_path.encode()).hexdigest()[:8]
    base, ext = posixpath.splitext(key)
    return f"{base}_{h}{ext}"


def _guess_content_type(
    path: str,
    manifest: dict[str, tuple[str, str]],
) -> str:
    for _id, (href, mtype) in manifest.items():
        if href == path:
            return mtype
    ext = posixpath.splitext(path)[1].lower()
    ct_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".css": "text/css",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
    }
    return ct_map.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# Sanitization wrapper for EPUB (reuses existing primitives)
# ---------------------------------------------------------------------------


def _epub_sanitize(html: str) -> str:
    """Sanitize chapter HTML using the platform sanitizer.

    Uses a synthetic base URL since EPUB internal refs are already rewritten.
    """
    from nexus.services.sanitize_html import sanitize_html

    return sanitize_html(html, base_url="https://epub.internal/")


# ---------------------------------------------------------------------------
# TOC materialization
# ---------------------------------------------------------------------------


def _materialize_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    opf_dir: str,
    manifest: dict[str, tuple[str, str]],
    href_to_frag_idx: dict[str, int],
    media_id: UUID,
) -> list[_TocNodeSpec]:
    """Try EPUB3 nav first, fall back to NCX."""
    nodes = _parse_epub3_nav(zf, opf, opf_dir, manifest, href_to_frag_idx)
    if nodes:
        return nodes
    return _parse_ncx_toc(zf, opf, opf_dir, manifest, href_to_frag_idx)


def _parse_epub3_nav(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    opf_dir: str,
    manifest: dict[str, tuple[str, str]],
    href_to_frag_idx: dict[str, int],
) -> list[_TocNodeSpec]:
    nav_id = None
    for item in opf.findall(".//opf:manifest/opf:item", _NS):
        props = item.get("properties", "")
        if "nav" in props.split():
            nav_id = item.get("id")
            break
    if nav_id is None or nav_id not in manifest:
        return []

    nav_href, _ = manifest[nav_id]
    nav_tree = _parse_xml_entry(zf, nav_href)
    if nav_tree is None:
        return []

    nav_dir = posixpath.dirname(nav_href)

    # find <nav epub:type="toc">
    toc_nav = None
    for nav_el in nav_tree.iter():
        tag = nav_el.tag
        if isinstance(tag, str) and tag.endswith("}nav"):
            if "toc" in nav_el.get("{http://www.idpf.org/2007/ops}type", ""):
                toc_nav = nav_el
                break
    if toc_nav is None:
        for nav_el in nav_tree.iter():
            tag = nav_el.tag
            if isinstance(tag, str) and (tag == "nav" or tag.endswith("}nav")):
                toc_nav = nav_el
                break
    if toc_nav is None:
        return []

    nodes: list[_TocNodeSpec] = []
    _walk_nav_ol(toc_nav, nav_dir, href_to_frag_idx, nodes, parent_id=None, depth=0, prefix="")
    return nodes


def _walk_nav_ol(
    parent_el: ET.Element,
    nav_dir: str,
    href_to_frag_idx: dict[str, int],
    nodes: list[_TocNodeSpec],
    parent_id: str | None,
    depth: int,
    prefix: str,
) -> None:
    ol = None
    for child in parent_el:
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag == "ol" or tag.endswith("}ol"):
            ol = child
            break
    if ol is None:
        return

    sibling_ids: dict[str, int] = {}
    ordinal = 0

    for li in ol:
        tag = li.tag if isinstance(li.tag, str) else ""
        if not (tag == "li" or tag.endswith("}li")):
            continue

        # find <a> or <span>
        label = ""
        href = None
        nav_id_attr = None
        for el in li:
            el_tag = el.tag if isinstance(el.tag, str) else ""
            if el_tag == "a" or el_tag.endswith("}a"):
                label = _text_content(el).strip()
                href = el.get("href")
                nav_id_attr = el.get("id")
                break
            if el_tag == "span" or el_tag.endswith("}span"):
                label = _text_content(el).strip()
                nav_id_attr = el.get("id")
                break

        if not label:
            label = _text_content(li).strip()
        if not label:
            continue

        # resolve href to fragment_idx
        frag_idx = None
        resolved_href = None
        if href:
            path_part = href.split("#")[0]
            resolved_href = (
                posixpath.normpath(posixpath.join(nav_dir, path_part)) if path_part else None
            )
            if resolved_href and resolved_href in href_to_frag_idx:
                frag_idx = href_to_frag_idx[resolved_href]

        # generate node_id
        raw_id = _generate_node_id_token(nav_id_attr, href, label)
        raw_id = _ensure_sibling_unique(raw_id, sibling_ids)
        node_id = f"{parent_id}/{raw_id}" if parent_id else raw_id
        node_id = _enforce_id_length(node_id)

        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"

        nodes.append(
            _TocNodeSpec(
                node_id=node_id,
                parent_node_id=parent_id,
                label=label[:512],
                href=href,
                fragment_idx=frag_idx,
                depth=depth,
                order_key=order_key,
            )
        )

        # recurse into nested ol
        _walk_nav_ol(
            li,
            nav_dir,
            href_to_frag_idx,
            nodes,
            parent_id=node_id,
            depth=depth + 1,
            prefix=order_key,
        )
        ordinal += 1


def _parse_ncx_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    opf_dir: str,
    manifest: dict[str, tuple[str, str]],
    href_to_frag_idx: dict[str, int],
) -> list[_TocNodeSpec]:
    ncx_id = None
    spine = opf.find(".//opf:spine", _NS)
    if spine is not None:
        ncx_id = spine.get("toc")
    if ncx_id is None:
        for _id, (_href, mtype) in manifest.items():
            if mtype == "application/x-dtbncx+xml":
                ncx_id = _id
                break
    if ncx_id is None or ncx_id not in manifest:
        return []

    ncx_href, _ = manifest[ncx_id]
    ncx_tree = _parse_xml_entry(zf, ncx_href)
    if ncx_tree is None:
        return []

    ncx_dir = posixpath.dirname(ncx_href)
    nav_map = ncx_tree.find(".//ncx:navMap", _NS)
    if nav_map is None:
        nav_map = ncx_tree.find(".//{http://www.daisy.org/z3986/2005/ncx/}navMap")
    if nav_map is None:
        return []

    nodes: list[_TocNodeSpec] = []
    _walk_ncx_navpoints(
        nav_map, ncx_dir, href_to_frag_idx, nodes, parent_id=None, depth=0, prefix=""
    )
    return nodes


def _walk_ncx_navpoints(
    parent_el: ET.Element,
    ncx_dir: str,
    href_to_frag_idx: dict[str, int],
    nodes: list[_TocNodeSpec],
    parent_id: str | None,
    depth: int,
    prefix: str,
) -> None:
    sibling_ids: dict[str, int] = {}
    ordinal = 0

    for np in parent_el:
        tag = np.tag if isinstance(np.tag, str) else ""
        if not (tag == "navPoint" or tag.endswith("}navPoint")):
            continue

        nav_id_attr = np.get("id")
        label_el = np.find("ncx:navLabel/ncx:text", _NS)
        if label_el is None:
            label_el = np.find(".//{http://www.daisy.org/z3986/2005/ncx/}text")
        label = (label_el.text or "").strip() if label_el is not None else ""
        if not label:
            continue

        content_el = np.find("ncx:content", _NS)
        if content_el is None:
            content_el = np.find(".//{http://www.daisy.org/z3986/2005/ncx/}content")
        href = content_el.get("src") if content_el is not None else None

        frag_idx = None
        if href:
            path_part = href.split("#")[0]
            resolved = posixpath.normpath(posixpath.join(ncx_dir, path_part)) if path_part else None
            if resolved and resolved in href_to_frag_idx:
                frag_idx = href_to_frag_idx[resolved]

        raw_id = _generate_node_id_token(nav_id_attr, href, label)
        raw_id = _ensure_sibling_unique(raw_id, sibling_ids)
        node_id = f"{parent_id}/{raw_id}" if parent_id else raw_id
        node_id = _enforce_id_length(node_id)

        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"

        nodes.append(
            _TocNodeSpec(
                node_id=node_id,
                parent_node_id=parent_id,
                label=label[:512],
                href=href,
                fragment_idx=frag_idx,
                depth=depth,
                order_key=order_key,
            )
        )

        _walk_ncx_navpoints(
            np,
            ncx_dir,
            href_to_frag_idx,
            nodes,
            parent_id=node_id,
            depth=depth + 1,
            prefix=order_key,
        )
        ordinal += 1


# ---------------------------------------------------------------------------
# Node ID helpers
# ---------------------------------------------------------------------------


def _generate_node_id_token(
    nav_id: str | None,
    href: str | None,
    label: str,
) -> str:
    """Priority: normalized nav id -> normalized href -> label slug."""
    if nav_id and nav_id.strip():
        return _slug(nav_id.strip())

    if href and href.strip():
        return _slug(href.strip())

    return _slug(label) or "node"


def _slug(text: str) -> str:
    t = unicodedata.normalize("NFC", text).lower()
    t = _SLUG_RE.sub("-", t).strip("-")
    return t[:64] if t else "node"


def _ensure_sibling_unique(raw: str, seen: dict[str, int]) -> str:
    if raw not in seen:
        seen[raw] = 0
        return raw
    seen[raw] += 1
    return f"{raw}~{seen[raw]}"


def _enforce_id_length(node_id: str) -> str:
    if len(node_id) <= 255:
        return node_id
    h = hashlib.sha256(node_id.encode()).hexdigest()[:16]
    return node_id[:238] + "~" + h


def _text_content(el: ET.Element) -> str:
    parts = []
    if el.text:
        parts.append(el.text)
    for child in el:
        parts.append(_text_content(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


# ---------------------------------------------------------------------------
# href -> fragment_idx mapping
# ---------------------------------------------------------------------------


def _build_href_to_frag_idx(
    chapter_specs: list[_ChapterSpec],
    fragments: list[Fragment],
) -> dict[str, int]:
    """Map chapter hrefs to their assigned contiguous fragment idx."""
    result: dict[str, int] = {}
    for ch in chapter_specs:
        for frag in fragments:
            if frag.idx < len(chapter_specs):
                if chapter_specs[frag.idx].href == ch.href:
                    result[ch.href] = frag.idx
                    break
    return result
