"""Project Gutenberg catalogue candidates (the search rule's ``gutenberg`` family) and Preview."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.browse import (
    EpubCandidate,
    EpubFacts,
    EpubPreview,
    EpubPreviewFacts,
    PreviewResolution,
)
from nexus.schemas.presence import absent, present
from nexus.schemas.presence import presence_from_nullable as maybe
from nexus.services.browse.targets import (
    BrowseTargetNotFound,
    ProjectGutenbergEpubTarget,
    seal_target,
)
from nexus.services.contributor_credits import load_contributor_credits_for_catalogue
from nexus.services.sealed_handles import DiscoveryTargetHandle
from nexus.services.search.sources import hydrate

_LANDING = "https://www.gutenberg.org/ebooks/{}"


def candidates(db: Session, viewer_id: UUID, ebook_ids: Sequence[int]) -> list[EpubCandidate]:
    """The catalogue rows of ``ebook_ids``, in order."""
    rows = {row["id"]: row for row in hydrate(db, viewer_id, "gutenberg", ebook_ids, "")}
    credits = load_contributor_credits_for_catalogue(db, list(rows))
    return [
        EpubCandidate(
            resolution=PreviewResolution(
                target=seal_target(ProjectGutenbergEpubTarget(ebookRef=str(ebook_id)))
            ),
            title=rows[ebook_id]["label"] or "Untitled ebook",
            contributors=credits.get(ebook_id, []),
            description=maybe(rows[ebook_id]["text"]),
            published_at=absent(),
            image=absent(),
            kind_facts=EpubFacts(ebook_ref=present(str(ebook_id))),
        )
        for ebook_id in ebook_ids
        if ebook_id in rows
    ]


def preview(
    db: Session, viewer_id: UUID, target: ProjectGutenbergEpubTarget, handle: DiscoveryTargetHandle
) -> EpubPreview:
    ref = target.ebook_ref
    found = (
        candidates(db, viewer_id, [int(ref)])
        if ref.isascii() and ref.isdecimal() and ref[0] != "0"
        else []
    )
    if not found:
        raise BrowseTargetNotFound
    landing = _LANDING.format(ref)
    return EpubPreview(
        target=handle,
        title=found[0].title,
        contributors=found[0].contributors,
        description=found[0].description,
        published_at=absent(),
        image=absent(),
        source_href=landing,
        resolution=PreviewResolution(target=handle),
        kind_facts=EpubPreviewFacts(ebook_ref=ref, import_href=f"{landing}.epub.noimages"),
    )
