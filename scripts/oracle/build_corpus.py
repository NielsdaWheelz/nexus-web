"""Seed the oracle corpus from local JSON manifests.

Reads scripts/oracle/manifest_works.json and manifest_plates.json,
resolves Wikimedia file-page URLs to upload CDN URLs, and writes rows
into oracle_corpus_set_versions, oracle_corpus_works, oracle_corpus_passages,
and oracle_corpus_images.

Corpus releases are immutable: if the version already exists, choose a new
ORACLE_CORPUS_VERSION instead of mutating it in place.

Run: `cd python && uv run python ../scripts/oracle/build_corpus.py`
"""

from __future__ import annotations

import hashlib
import json
import os
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
    OracleCorpusSetVersion,
    OracleCorpusWork,
)
from nexus.db.session import get_session_factory
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

MANIFEST_DIR = Path(__file__).resolve().parent
WORKS_PATH = MANIFEST_DIR / "manifest_works.json"
PLATES_PATH = MANIFEST_DIR / "manifest_plates.json"
WIKI_API_URL = "https://commons.wikimedia.org/w/api.php"
CORPUS_VERSION = os.environ.get("ORACLE_CORPUS_VERSION", "black-forest-oracle-v1")
CORPUS_LABEL = os.environ.get("ORACLE_CORPUS_LABEL", "Black Forest Oracle v1")


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


def _ensure_corpus_set_version(db: Any) -> Any:
    existing = db.execute(
        select(OracleCorpusSetVersion).where(OracleCorpusSetVersion.version == CORPUS_VERSION)
    ).scalar_one_or_none()
    embedding_model = current_transcript_embedding_model()
    if existing is not None:
        raise SystemExit(
            f"Oracle corpus version {CORPUS_VERSION!r} already exists. "
            "Corpus releases are immutable; set ORACLE_CORPUS_VERSION to a new value."
        )

    version = OracleCorpusSetVersion(
        version=CORPUS_VERSION,
        label=CORPUS_LABEL,
        embedding_model=embedding_model,
    )
    db.add(version)
    db.flush()
    return version


def _seed_works(db: Any, corpus_set_version_id: Any, manifest: list[dict[str, Any]]) -> None:
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
            select(OracleCorpusWork).where(
                OracleCorpusWork.corpus_set_version_id == corpus_set_version_id,
                OracleCorpusWork.slug == slug,
            )
        ).scalar_one_or_none()
        if existing is None:
            work = OracleCorpusWork(
                corpus_set_version_id=corpus_set_version_id,
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
                f"Oracle corpus work {slug!r} already exists in {CORPUS_VERSION!r}; "
                "choose a new corpus version instead of mutating a release."
            )
        for passage in entry["passages"]:
            existing_passage = db.execute(
                select(OracleCorpusPassage).where(
                    OracleCorpusPassage.corpus_set_version_id == corpus_set_version_id,
                    OracleCorpusPassage.work_id == work.id,
                    OracleCorpusPassage.passage_index == passage["passage_index"],
                )
            ).scalar_one_or_none()
            if existing_passage is None:
                db.execute(
                    text(
                        """
                        INSERT INTO oracle_corpus_passages (
                            corpus_set_version_id,
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
                            :corpus_set_version_id,
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
                        "corpus_set_version_id": corpus_set_version_id,
                        "work_id": work.id,
                        "passage_index": passage["passage_index"],
                        "canonical_text": passage["canonical_text"],
                        "locator_label": passage["locator_label"],
                        "locator": _passage_locator(passage),
                        "source": _passage_source(entry, passage),
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
                    f"in {CORPUS_VERSION!r}; choose a new corpus version."
                )
    db.commit()


def _seed_plates(
    db: Any,
    client: httpx.Client,
    corpus_set_version_id: Any,
    manifest: list[dict[str, Any]],
) -> None:
    resolved_entries: list[dict[str, Any]] = []
    for entry in manifest:
        file_page_url = entry["source_url"]
        try:
            resolved, width, height = _plate_image_metadata(client, entry)
        except (httpx.HTTPError, RuntimeError, KeyError) as exc:
            print(
                f"warn: skipping plate {entry['work_title']!r}: "
                f"could not resolve {file_page_url}: {exc}",
                file=sys.stderr,
            )
            continue
        time.sleep(0.2)  # be polite to Wikimedia
        resolved_entries.append(
            {
                **entry,
                "source_page_url": entry["source_url"],
                "resolved_source_url": resolved,
                "license_text": str(entry.get("license_text") or "public domain"),
                "width": width,
                "height": height,
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
            select(OracleCorpusImage).where(
                OracleCorpusImage.corpus_set_version_id == corpus_set_version_id,
                OracleCorpusImage.source_url == entry["resolved_source_url"],
            )
        ).scalar_one_or_none()
        if existing is None:
            db.execute(
                text(
                    """
                    INSERT INTO oracle_corpus_images (
                        corpus_set_version_id,
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
                        tags,
                        embedding_model,
                        embedding
                    )
                    VALUES (
                        :corpus_set_version_id,
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
                        :tags,
                        :embedding_model,
                        CAST(:embedding AS vector(256))
                    )
                    """
                ).bindparams(bindparam("tags", type_=JSONB)),
                {
                    "corpus_set_version_id": corpus_set_version_id,
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
                    "tags": entry["tags"],
                    "embedding_model": embedding_model,
                    "embedding": to_pgvector_literal(embedding),
                },
            )
        else:
            raise SystemExit(
                f"Oracle corpus plate {entry['resolved_source_url']!r} already exists in "
                f"{CORPUS_VERSION!r}; "
                "choose a new corpus version instead of mutating a release."
            )
    db.commit()


def _passage_locator(passage: dict[str, Any]) -> dict[str, Any]:
    locator = passage.get("locator")
    if isinstance(locator, dict) and locator:
        return dict(locator)
    return {
        "type": "manifest_locator",
        "label": passage["locator_label"],
        "passage_index": int(passage["passage_index"]),
    }


def _passage_source(work: dict[str, Any], passage: dict[str, Any]) -> dict[str, Any]:
    citation_key = _citation_key(work, passage)
    return {
        "type": "public_domain_work",
        "citation_key": citation_key,
        "repository": work["source_repository"],
        "url": work["source_url"],
        "work_slug": work["slug"],
        "title": work["title"],
        "author": work["author"],
        "edition_label": work["edition_label"],
        "year": work.get("year"),
    }


def _citation_key(work: dict[str, Any], passage: dict[str, Any]) -> str:
    payload = {
        "type": "oracle_corpus_passage",
        "corpus_version": CORPUS_VERSION,
        "work_slug": work["slug"],
        "passage_index": int(passage["passage_index"]),
        "text_sha256": hashlib.sha256(passage["canonical_text"].encode("utf-8")).hexdigest(),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _manifest_counts(
    works: list[dict[str, Any]],
    plates: list[dict[str, Any]],
) -> tuple[int, int, int]:
    return len(works), sum(len(work["passages"]) for work in works), len(plates)


def _validate_corpus_counts(
    db: Any,
    corpus_set_version_id: Any,
    *,
    expected_works: int,
    expected_passages: int,
    expected_images: int,
) -> None:
    counts = (
        db.execute(
            select(
                func.count(func.distinct(OracleCorpusWork.id)).label("work_count"),
                func.count(func.distinct(OracleCorpusPassage.id)).label("passage_count"),
                func.count(func.distinct(OracleCorpusImage.id)).label("image_count"),
                func.count(func.distinct(OracleCorpusPassage.id))
                .filter(
                    OracleCorpusPassage.embedding_model == OracleCorpusSetVersion.embedding_model,
                    OracleCorpusPassage.embedding.is_not(None),
                )
                .label("passage_embedding_count"),
                func.count(func.distinct(OracleCorpusImage.id))
                .filter(
                    OracleCorpusImage.embedding_model == OracleCorpusSetVersion.embedding_model,
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
            .select_from(OracleCorpusSetVersion)
            .outerjoin(
                OracleCorpusWork,
                OracleCorpusWork.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .outerjoin(
                OracleCorpusPassage,
                OracleCorpusPassage.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .outerjoin(
                OracleCorpusImage,
                OracleCorpusImage.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .where(OracleCorpusSetVersion.id == corpus_set_version_id)
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
        raise SystemExit(
            f"Oracle corpus seed incomplete for {CORPUS_VERSION}: {', '.join(missing)}"
        )


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
    with httpx.Client(
        headers={"User-Agent": "nexus-oracle-seed/0.1 (https://nexus.example)"}
    ) as client:
        with session_factory() as db:
            corpus_set_version = _ensure_corpus_set_version(db)
            _seed_works(db, corpus_set_version.id, works)
            _seed_plates(db, client, corpus_set_version.id, plates)
            _validate_corpus_counts(
                db,
                corpus_set_version.id,
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
