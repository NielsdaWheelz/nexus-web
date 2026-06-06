"""Seed the oracle corpus from local JSON manifests.

Reads scripts/oracle/manifest_works.json and manifest_plates.json,
resolves Wikimedia file-page URLs to upload CDN URLs, and writes current rows
into oracle_corpus_works, oracle_corpus_passages, and oracle_corpus_images.

The script seeds the single current Oracle corpus. Existing current rows are a
data-repair concern, not a reason to create another corpus.

The build now downloads, validates, and uploads each plate's bytes into R2
object storage, so it requires the R2 storage env (R2_S3_API_ORIGIN,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).

Run: `cd python && uv run python ../scripts/oracle/build_corpus.py`
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.dialects.postgresql import JSONB

from nexus.db.models import (
    OracleCorpusImage,
    OracleCorpusPassage,
    OracleCorpusWork,
)
from nexus.db.session import get_session_factory
from nexus.services.image_validation import fetch_validated_image
from nexus.services.oracle import (
    ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES,
    ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES,
    ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS,
)
from nexus.services.semantic_chunks import (
    build_text_embeddings,
    current_transcript_embedding_model,
    to_pgvector_literal,
)
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.storage.paths import ext_for_content_type

MANIFEST_DIR = Path(__file__).resolve().parent
WORKS_PATH = MANIFEST_DIR / "manifest_works.json"
PLATES_PATH = MANIFEST_DIR / "manifest_plates.json"
WIKI_API_URL = "https://commons.wikimedia.org/w/api.php"

def _resolve_wikimedia_image(client: httpx.Client, file_page_url: str) -> tuple[str, int, int]:
    """Resolve a `commons.wikimedia.org/wiki/File:Name.jpg` URL to (cdn_url, width, height)."""
    parsed = urllib.parse.urlparse(file_page_url)
    path_marker = "/wiki/"
    if path_marker not in parsed.path:
        raise RuntimeError(f"Not a Wikimedia file-page URL: {file_page_url}")
    title = urllib.parse.unquote(parsed.path.split(path_marker, 1)[1])
    response = client.get(
        WIKI_API_URL,
        params={
            "action": "query",
            "titles": title,
            "prop": "imageinfo",
            "iiprop": "url|size|mime",
            "format": "json",
        },
        timeout=20.0,
    )
    response.raise_for_status()
    pages = response.json()["query"]["pages"]
    page = next(iter(pages.values()))
    image_info = page.get("imageinfo")
    if not image_info:
        raise RuntimeError(f"Wikimedia did not resolve image info for {file_page_url}")
    info = image_info[0]
    mime = str(info.get("mime") or "")
    width = int(info["width"])
    height = int(info["height"])
    if (
        mime not in {"image/jpeg", "image/png", "image/webp", "image/gif"}
        or width <= 0
        or height <= 0
    ):
        raise RuntimeError(f"Wikimedia file is not a usable image: {file_page_url}")
    return str(info["url"]).split("?", 1)[0], width, height


def _plate_image_metadata(
    client: httpx.Client,
    entry: dict[str, Any],
) -> tuple[str, int, int]:
    resolved = entry.get("resolved_source_url")
    width = entry.get("width")
    height = entry.get("height")
    if isinstance(resolved, str) and isinstance(width, int) and isinstance(height, int):
        if resolved and width > 0 and height > 0:
            return resolved, width, height
    return _resolve_wikimedia_image(client, entry["source_url"])


def _seed_works(db: Any, manifest: list[dict[str, Any]]) -> None:
    passage_texts = [
        " ".join([passage["canonical_text"], *[str(tag) for tag in passage["tags"]]])
        for entry in manifest
        for passage in entry["passages"]
    ]
    embedding_model, passage_embeddings = build_text_embeddings(passage_texts)
    passage_embedding_index = 0
    for entry in manifest:
        slug = entry["slug"]
        existing = db.execute(
            select(OracleCorpusWork).where(OracleCorpusWork.slug == slug)
        ).scalar_one_or_none()
        if existing is None:
            work = OracleCorpusWork(
                slug=slug,
                title=entry["title"],
                author=entry["author"],
                year=entry.get("year"),
                edition_label=entry["edition_label"],
                source_repository=entry["source_repository"],
                source_url=entry["source_url"],
            )
            db.add(work)
            db.flush()
        else:
            raise SystemExit(
                f"Oracle current corpus work {slug!r} already exists; "
                "clear current corpus rows before reseeding."
            )
        for passage in entry["passages"]:
            existing_passage = db.execute(
                select(OracleCorpusPassage).where(
                    OracleCorpusPassage.work_id == work.id,
                    OracleCorpusPassage.passage_index == passage["passage_index"],
                )
            ).scalar_one_or_none()
            if existing_passage is None:
                db.execute(
                    text(
                        """
                        INSERT INTO oracle_corpus_passages (
                            work_id,
                            passage_index,
                            canonical_text,
                            locator_label,
                            locator,
                            source,
                            tags,
                            embedding_model,
                            embedding
                        )
                        VALUES (
                            :work_id,
                            :passage_index,
                            :canonical_text,
                            :locator_label,
                            :locator,
                            :source,
                            :tags,
                            :embedding_model,
                            CAST(:embedding AS vector(256))
                        )
                        """
                    ).bindparams(
                        bindparam("locator", type_=JSONB),
                        bindparam("source", type_=JSONB),
                        bindparam("tags", type_=JSONB),
                    ),
                    {
                        "work_id": work.id,
                        "passage_index": passage["passage_index"],
                        "canonical_text": passage["canonical_text"],
                        "locator_label": passage["locator_label"],
                        "locator": _passage_locator(passage),
                        "source": _passage_source(entry),
                        "tags": passage["tags"],
                        "embedding_model": embedding_model,
                        "embedding": to_pgvector_literal(
                            passage_embeddings[passage_embedding_index]
                        ),
                    },
                )
                passage_embedding_index += 1
            else:
                raise SystemExit(
                    f"Oracle corpus passage {slug!r}:{passage['passage_index']} already exists "
                    "in the current corpus."
                )
    db.commit()


def _seed_plates(
    db: Any,
    client: httpx.Client,
    storage: StorageClientBase,
    manifest: list[dict[str, Any]],
) -> None:
    resolved_entries: list[dict[str, Any]] = []
    for entry in manifest:
        file_page_url = entry["source_url"]
        try:
            resolved, _w, _h = _plate_image_metadata(client, entry)
        except (httpx.HTTPError, RuntimeError, KeyError) as exc:
            print(
                f"warn: skipping plate {entry['work_title']!r}: "
                f"could not resolve {file_page_url}: {exc}",
                file=sys.stderr,
            )
            continue
        validated = fetch_validated_image(resolved, client)
        storage_key = _plate_storage_key(entry, content_type=validated.content_type)
        if storage.head_object(storage_key) is None:
            storage.put_object(storage_key, validated.data, validated.content_type)
        time.sleep(0.2)  # be polite to Wikimedia
        resolved_entries.append(
            {
                **entry,
                "source_page_url": entry["source_url"],
                "resolved_source_url": resolved,
                "license_text": str(entry.get("license_text") or "public domain"),
                "width": validated.width,
                "height": validated.height,
                "storage_key": storage_key,
                "content_type": validated.content_type,
                "byte_size": len(validated.data),
            }
        )

    embedding_model, image_embeddings = build_text_embeddings(
        [
            " ".join([entry["work_title"], *[str(tag) for tag in entry["tags"]]])
            for entry in resolved_entries
        ]
    )
    for entry, embedding in zip(resolved_entries, image_embeddings, strict=True):
        existing = db.execute(
            select(OracleCorpusImage).where(OracleCorpusImage.source_url == entry["resolved_source_url"])
        ).scalar_one_or_none()
        if existing is None:
            db.execute(
                text(
                    """
                    INSERT INTO oracle_corpus_images (
                        source_repository,
                        source_page_url,
                        source_url,
                        license_text,
                        artist,
                        work_title,
                        year,
                        attribution_text,
                        width,
                        height,
                        storage_key,
                        content_type,
                        byte_size,
                        tags,
                        embedding_model,
                        embedding
                    )
                    VALUES (
                        :source_repository,
                        :source_page_url,
                        :source_url,
                        :license_text,
                        :artist,
                        :work_title,
                        :year,
                        :attribution_text,
                        :width,
                        :height,
                        :storage_key,
                        :content_type,
                        :byte_size,
                        :tags,
                        :embedding_model,
                        CAST(:embedding AS vector(256))
                    )
                    """
                ).bindparams(bindparam("tags", type_=JSONB)),
                {
                    "source_repository": entry["source_repository"],
                    "source_page_url": entry["source_page_url"],
                    "source_url": entry["resolved_source_url"],
                    "license_text": entry["license_text"],
                    "artist": entry["artist"],
                    "work_title": entry["work_title"],
                    "year": entry.get("year"),
                    "attribution_text": entry["attribution_text"],
                    "width": entry["width"],
                    "height": entry["height"],
                    "storage_key": entry["storage_key"],
                    "content_type": entry["content_type"],
                    "byte_size": entry["byte_size"],
                    "tags": entry["tags"],
                    "embedding_model": embedding_model,
                    "embedding": to_pgvector_literal(embedding),
                },
            )
        else:
            raise SystemExit(
                f"Oracle corpus plate {entry['resolved_source_url']!r} already exists in "
                "the current corpus."
            )
    db.commit()


def _plate_storage_key(entry: dict[str, Any], *, content_type: str) -> str:
    ext = ext_for_content_type(content_type)
    parsed = urllib.parse.urlparse(str(entry["source_url"]))
    source_name = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
    if source_name.startswith("File:"):
        source_name = source_name.removeprefix("File:")
    stem = source_name.rsplit(".", 1)[0] or str(entry["work_title"])
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    if not slug:
        raise RuntimeError(f"Could not derive Oracle plate storage key for {entry['source_url']}")
    return f"oracle/plates/{slug}.{ext}"


def _passage_locator(passage: dict[str, Any]) -> dict[str, Any]:
    locator = passage.get("locator")
    if isinstance(locator, dict) and locator:
        return dict(locator)
    return {
        "type": "manifest_locator",
        "label": passage["locator_label"],
        "passage_index": int(passage["passage_index"]),
    }


def _passage_source(work: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "public_domain_work",
        "repository": work["source_repository"],
        "url": work["source_url"],
        "work_slug": work["slug"],
        "title": work["title"],
        "author": work["author"],
        "edition_label": work["edition_label"],
        "year": work.get("year"),
    }


def _manifest_counts(
    works: list[dict[str, Any]],
    plates: list[dict[str, Any]],
) -> tuple[int, int, int]:
    return len(works), sum(len(work["passages"]) for work in works), len(plates)


def _validate_corpus_counts(
    db: Any,
    *,
    expected_works: int,
    expected_passages: int,
    expected_images: int,
) -> None:
    embedding_model = current_transcript_embedding_model()
    counts = (
        db.execute(
            select(
                func.count(func.distinct(OracleCorpusWork.id)).label("work_count"),
                func.count(func.distinct(OracleCorpusPassage.id)).label("passage_count"),
                func.count(func.distinct(OracleCorpusImage.id)).label("image_count"),
                func.count(func.distinct(OracleCorpusPassage.id))
                .filter(
                    OracleCorpusPassage.embedding_model == embedding_model,
                    OracleCorpusPassage.embedding.is_not(None),
                )
                .label("passage_embedding_count"),
                func.count(func.distinct(OracleCorpusImage.id))
                .filter(
                    OracleCorpusImage.embedding_model == embedding_model,
                    OracleCorpusImage.embedding.is_not(None),
                )
                .label("image_embedding_count"),
                func.count(func.distinct(OracleCorpusImage.id))
                .filter(
                    OracleCorpusImage.width <= 4096,
                    OracleCorpusImage.height <= 4096,
                )
                .label("safe_image_count"),
            )
            .select_from(OracleCorpusWork)
            .outerjoin(OracleCorpusPassage, OracleCorpusPassage.work_id == OracleCorpusWork.id)
            .outerjoin(OracleCorpusImage, text("true"))
        )
        .mappings()
        .one()
    )
    work_count = int(counts["work_count"] or 0)
    passage_count = int(counts["passage_count"] or 0)
    image_count = int(counts["image_count"] or 0)
    passage_embedding_count = int(counts["passage_embedding_count"] or 0)
    image_embedding_count = int(counts["image_embedding_count"] or 0)
    safe_image_count = int(counts["safe_image_count"] or 0)
    missing: list[str] = []
    if work_count < expected_works:
        missing.append(f"works={work_count}/{expected_works}")
    if passage_count < expected_passages:
        missing.append(f"passages={passage_count}/{expected_passages}")
    if image_count < expected_images:
        missing.append(f"images={image_count}/{expected_images}")
    if passage_embedding_count < expected_passages:
        missing.append(f"passage_embeddings={passage_embedding_count}/{expected_passages}")
    if image_embedding_count < expected_images:
        missing.append(f"image_embeddings={image_embedding_count}/{expected_images}")
    if safe_image_count < expected_images:
        missing.append(f"safe_images={safe_image_count}/{expected_images}")
    if missing:
        raise SystemExit(f"Oracle current corpus seed incomplete: {', '.join(missing)}")


def main() -> None:
    works = json.loads(WORKS_PATH.read_text(encoding="utf-8"))
    plates = json.loads(PLATES_PATH.read_text(encoding="utf-8"))
    manifest_work_count, manifest_passage_count, manifest_image_count = _manifest_counts(
        works,
        plates,
    )
    expected_works = max(manifest_work_count, ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS)
    expected_passages = max(manifest_passage_count, ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES)
    expected_images = max(manifest_image_count, ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES)
    session_factory = get_session_factory()
    storage = get_storage_client()
    with httpx.Client(
        headers={"User-Agent": "nexus-oracle-seed/0.1 (https://nexus.example)"}
    ) as client:
        with session_factory() as db:
            _seed_works(db, works)
            _seed_plates(db, client, storage, plates)
            _validate_corpus_counts(
                db,
                expected_works=expected_works,
                expected_passages=expected_passages,
                expected_images=expected_images,
            )
    print(
        "seeded "
        f"works={manifest_work_count} "
        f"passages={manifest_passage_count} "
        f"plates={manifest_image_count}"
    )


if __name__ == "__main__":
    main()
