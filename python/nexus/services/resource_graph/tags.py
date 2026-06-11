"""User-owned tag resources for the resource graph."""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Tag
from nexus.services.resource_graph.refs import ResourceRef

TAG_TEXT_RE = re.compile(r"(?<![A-Za-z0-9_])#([A-Za-z0-9][A-Za-z0-9_-]{0,79})")


def tag_names_from_text(text: str) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for match in TAG_TEXT_RE.finditer(text):
        name = match.group(1)
        slug = slug_for_tag_name(name)
        if slug in seen:
            continue
        seen.add(slug)
        names.append(name)
    return names


def ref_for_tag_name(db: Session, *, viewer_id: UUID, name: str) -> ResourceRef:
    tag = _get_or_create_tag(db, viewer_id=viewer_id, name=name)
    return ResourceRef(scheme="tag", id=tag.id)


def slug_for_tag_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")


def _get_or_create_tag(db: Session, *, viewer_id: UUID, name: str) -> Tag:
    slug = slug_for_tag_name(name)
    tag = db.scalar(select(Tag).where(Tag.user_id == viewer_id, Tag.slug == slug))
    if tag is not None:
        return tag

    tag = Tag(user_id=viewer_id, name=name, slug=slug)
    try:
        with db.begin_nested():
            db.add(tag)
            db.flush()
    except IntegrityError as exc:
        if integrity_constraint_name(exc) != "uix_tags_user_slug":
            raise
        tag = db.scalar(select(Tag).where(Tag.user_id == viewer_id, Tag.slug == slug))
        if tag is None:
            raise
    return tag
