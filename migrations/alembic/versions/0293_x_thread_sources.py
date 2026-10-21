"""Replace aggregate X captures with canonical posts and thread composition.

Stopped writers and settled X attempts are required. Published identities,
filings and frozen quotations survive; unprovable ownership aborts the entire
transaction with a repair inventory. No provider reads or internal commits.

Rendering, preparation and writes are d6f04890c's, the release that ran this
revision, frozen in the sibling package ``0293_x_thread_sources/``. Nothing here
imports the application, so its later schema cannot reach this revision. The census
line records the conversion in the release log.
"""

import importlib.util
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

import sqlalchemy as sa
from alembic import op
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
    model_validator,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Session
from uuid6 import uuid7 as new_uuid7

if "m0293" not in sys.modules:
    _package = Path(__file__).with_suffix("")
    _spec = importlib.util.spec_from_file_location(
        "m0293", _package / "__init__.py", submodule_search_locations=[str(_package)]
    )
    assert _spec is not None and _spec.loader is not None
    sys.modules["m0293"] = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(sys.modules["m0293"])

from m0293 import text_quote as tq
from m0293 import writes
from m0293.canonicalize import canonicalize_structure, generate_canonical_text
from m0293.contributor_taxonomy import (
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
)
from m0293.html_tree import inner_html, parse_html_document
from m0293.schemas import (
    StoredReaderCursor,
    XPostContent,
    XSourceAttachment,
    XSourceAuthor,
    XSourcePost,
    XSourceUrl,
)
from m0293.support import compute_anchor_key, normalize_quote_text
from m0293.x_identity import classify_x_url
from m0293.x_rendering import render_post
from m0293.x_source import post_label

revision = "0293"
down_revision = "0292"
branch_labels = None
depends_on = None


# The 0292 snapshot grammar is frozen here. Curated recovered thread records may
# explicitly lack historical enumeration evidence. This is never a runtime reader.
_Revision = Annotated[str, Field(pattern=r"^[0-9]+$")]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class _Reference(_Closed):
    kind: Literal["quoted", "replied_to", "retweeted"]
    post_id: _Revision
    availability: Literal["available", "unavailable", "not_captured"]


class _Post(_Closed):
    id: _Revision
    author: XSourceAuthor
    text: str
    created_at: AwareDatetime | None
    language: str | None
    urls: tuple[XSourceUrl, ...]
    attachments: tuple[XSourceAttachment, ...]
    references: tuple[_Reference, ...]


class _Snapshot(_Closed):
    source_kind: Literal["author_thread", "post"]
    requested_post_id: _Revision
    primary_post_ids: Annotated[tuple[_Revision, ...], Field(min_length=1)]
    posts: dict[str, _Post]
    enumeration: Literal["exhausted", "post_limit"] | None

    @model_validator(mode="after")
    def graph(self) -> "_Snapshot":
        primary = set(self.primary_post_ids)
        if (
            len(primary) != len(self.primary_post_ids)
            or self.requested_post_id not in primary
        ):
            raise ValueError("primary ids must be unique and retain the requested post")
        if not primary <= self.posts.keys():
            raise ValueError("primary source body missing")
        if self.source_kind == "post" and (
            self.primary_post_ids != (self.requested_post_id,)
            or self.enumeration != "exhausted"
        ):
            raise ValueError("singleton source shape contradicts its scope")
        direct = {
            r.post_id
            for p in primary
            for r in self.posts[p].references
            if r.availability == "available"
        }
        if self.posts.keys() != primary | direct:
            raise ValueError("snapshot contains unowned or missing direct context")
        for key, post in self.posts.items():
            if key != post.id:
                raise ValueError("post key contradicts revision")
            for ref in post.references:
                if (ref.availability == "available") != (ref.post_id in self.posts):
                    raise ValueError(
                        "reference availability contradicts captured bodies"
                    )
        return self


@dataclass(frozen=True)
class _Capture:
    media_id: UUID
    attempt_id: UUID
    published_at: datetime
    viewer_id: UUID
    generation: int
    source: _Snapshot


@dataclass(frozen=True)
class _Region:
    revision: str
    primary: str
    relation: str
    start: int
    end: int
    occurrence_key: str | None = None


@dataclass(frozen=True)
class _Body:
    media_id: UUID
    text: str
    regions: tuple[_Region, ...]
    source_offsets: dict[int, int] | None = None


@dataclass(frozen=True)
class _Wrapper:
    media_id: UUID
    fragment_ids: tuple[UUID, ...]
    prepared: tuple[tuple[Any, str], ...]
    embeds: tuple[dict[str, Any], ...]


def _stop(reason: str, **inventory: Any) -> None:
    raise RuntimeError(
        "0293 X repair required: "
        + json.dumps({"reason": reason, **inventory}, default=str, sort_keys=True)
    )


def _url(revision_id: str) -> str:
    return f"https://x.com/i/status/{revision_id}"


def _byline(post: _Post) -> str:
    parts = [
        f"<p><strong>{escape(post.author.name)}</strong>"
        if post.author.name
        else "<p>",
        f' <a href="https://x.com/{escape(post.author.username, quote=True)}">@{escape(post.author.username)}</a>',
    ]
    if post.created_at is not None:
        stamp = post.created_at.isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        parts.append(f" - {stamp}")
    return "".join(parts) + f' - <a href="{_url(post.id)}">Open on X</a></p>'


def _old_body(post: _Post, *, inline_era: bool = False) -> str:
    quoted = (
        {r.post_id for r in post.references if r.kind == "quoted"}
        if not inline_era
        else set()
    )
    value = post.text
    for entity in post.urls:
        if any(
            (identity := classify_x_url(url)) is not None
            and identity.provider_id in quoted
            for url in (entity.url, entity.expanded_url or "")
        ):
            value = value.replace(entity.url, "")
    value = value.strip()
    parts = [
        f"<p>{'<br>'.join(escape(line, quote=False) for line in value.splitlines())}</p>"
    ]
    for entity in post.urls:
        if inline_era or entity.url in value:
            href = (
                entity.expanded_url if entity.expanded_url is not None else entity.url
            )
            label = (
                entity.display_url
                if entity.display_url is not None
                else entity.title
                if entity.title is not None
                else href
            )
            if inline_era:
                href = entity.expanded_url or entity.url
                label = entity.display_url or entity.title or href
            parts.append(
                f'<p><a href="{escape(href, quote=True)}">{escape(label, quote=False)}</a></p>'
            )
    for item in post.attachments:
        image = item.url if item.url is not None else item.preview_image_url
        if inline_era:
            image = item.url or item.preview_image_url
        if image is not None:
            alt = item.alt_text if item.alt_text is not None else item.type
            if inline_era:
                alt = item.alt_text or item.type
            parts.append(
                f'<figure><img src="{escape(image, quote=True)}" alt="{escape(alt, quote=True)}"><figcaption>{escape(item.type, quote=False)}</figcaption></figure>'
            )
    return "".join(parts)


def _old_regions(source: _Snapshot, index: int, actual: str) -> tuple[_Region, ...]:
    """Reproduce the pinned renderer's source boundaries, including copied reply prose."""
    post = source.posts[source.primary_post_ids[index]]
    # The third, explicitly pinned renderer predates quote transclusion:
    # git 36a0b7ea6^:python/nexus/services/x_rendering.py. It copied direct
    # quoted bodies, and rendered no reply/repost context. Full canonical output
    # must match; DOM resemblance or a common substring never admits this variant.
    for mode in ("0292_embed", "0292_link", "inline"):
        parts = [
            (
                post.id,
                "primary",
                f"<h2>Post {index + 1}</h2>"
                + _byline(post)
                + _old_body(post, inline_era=mode == "inline"),
            )
        ]
        for ref in post.references:
            if ref.kind != "quoted":
                continue
            target = source.posts.get(ref.post_id)
            if mode == "inline":
                if target is not None and source.source_kind == "author_thread":
                    label = f"Quoted post by {target.author.name} (@{target.author.username})"
                    parts.append(
                        (
                            target.id,
                            "quoted",
                            f"<blockquote><p><strong>{escape(label)}</strong></p>"
                            + _old_body(target, inline_era=True)
                            + "<p>Open quoted post</p></blockquote>",
                        )
                    )
                else:
                    parts.append(
                        (
                            post.id,
                            "primary",
                            "<blockquote><p>Quoted post unavailable in this archival snapshot.</p><p>Open quoted post on X</p></blockquote>",
                        )
                    )
                continue
            if mode == "0292_link" or source.source_kind == "post":
                label = "Quotes another X post — Open on X"
            elif target is not None:
                label = f"Quoted X post by @{target.author.username} — Open in Nexus"
            else:
                label = "Quoted X post unavailable — Open on X"
            # A generated reference belongs to its referring post, not to foreign words.
            parts.append((post.id, "primary", f"<p>{escape(label, quote=False)}</p>"))
        for ref in post.references:
            if (
                mode == "inline"
                or ref.kind == "quoted"
                or ref.post_id in source.primary_post_ids
            ):
                continue
            target = source.posts.get(ref.post_id)
            label = "Replying to" if ref.kind == "replied_to" else "Reposted"
            if target is None:
                status = (
                    "unavailable"
                    if ref.availability == "unavailable"
                    else "not captured"
                )
                parts.append(
                    (
                        post.id,
                        "primary",
                        f"<p>{label} an X post ({status}) — Open on X</p>",
                    )
                )
            else:
                parts.append(
                    (
                        target.id,
                        ref.kind,
                        f"<p>{label}</p>" + _byline(target) + _old_body(target),
                    )
                )
        texts = [generate_canonical_text(html) for _, _, html in parts]
        if "\n".join(texts) != actual:
            continue
        regions = []
        start = 0
        for (revision, relation, _), body in zip(parts, texts, strict=True):
            regions.append(
                _Region(revision, post.id, relation, start, start + len(body))
            )
            start += len(body) + 1
        return tuple(regions)
    _stop("stored fragment does not match a pinned X rendering", revision_id=post.id)
    raise AssertionError("unreachable")


def _match(
    text: str, exact: str, prefix: str = "", suffix: str = ""
) -> tuple[int, int] | None:
    needle = tq.normalize_for_match(exact).text.strip()
    if not needle:
        return None
    normalized = tq.normalize_for_match(text)
    hits = tq.find_quote_candidates(
        normalized,
        exact=needle,
        prefix=tq.normalize_for_match(prefix).text.strip(),
        suffix=tq.normalize_for_match(suffix).text.strip(),
    )
    if not hits:
        hits = tq.find_quote_candidates(normalized, exact=needle, prefix="", suffix="")
    return (hits[0].raw_start, hits[0].raw_end) if len(hits) == 1 else None


def _current_match(
    fragments: list[tuple[UUID, str]], exact: str, prefix: str = "", suffix: str = ""
) -> tuple[UUID, int, int] | None:
    # Uniqueness belongs to the entire canonical owner, including ambiguity
    # within any one fragment. Never discard an ambiguous fragment then pick another.
    needle = tq.normalize_for_match(exact).text.strip()
    if not needle:
        return None
    for before, after in ((prefix, suffix), ("", "")):
        hits = [
            (identity, hit.raw_start, hit.raw_end)
            for identity, body in fragments
            for hit in tq.find_quote_candidates(
                tq.normalize_for_match(body),
                exact=needle,
                prefix=tq.normalize_for_match(before).text.strip(),
                suffix=tq.normalize_for_match(after).text.strip(),
            )
        ]
        if hits:
            return hits[0] if len(hits) == 1 else None
    return None


def _source_offsets(
    old: str, removed: list[tuple[int, int]], current: str, *, fragment_id: UUID
) -> dict[int, int]:
    """Prove unchanged source words and map retained coordinates across caption removal."""
    positions: list[int] = []
    start = 0
    for a, b in [*removed, (len(old), len(old))]:
        if a < start or b < a or b > len(old):
            _stop(
                "overlapping or invalid old X caption bounds",
                fragment_id=fragment_id,
                bounds=removed,
            )
        positions.extend(range(start, a))
        start = b
    retained = "".join(old[i] for i in positions)
    left, right = tq.normalize_for_match(retained), tq.normalize_for_match(current)
    if left.text.strip() != right.text.strip():
        _stop(
            "X caption removal would change real article words", fragment_id=fragment_id
        )
    offsets: dict[int, int] = {}
    ltrim, rtrim = (
        len(left.text) - len(left.text.lstrip()),
        len(right.text) - len(right.text.lstrip()),
    )
    for index in range(len(left.text.strip())):
        a, b = left.boundaries[index + ltrim : index + ltrim + 2]
        c, d = right.boundaries[index + rtrim : index + rtrim + 2]
        if b - a == d - c:
            for delta in range(b - a):
                offsets[positions[a + delta]] = c + delta
                offsets[positions[a + delta] + 1] = c + delta + 1
        else:
            offsets[positions[a]] = c
            offsets[positions[b - 1] + 1] = d
    return offsets


def _prepare_wrappers(
    db: Session,
    *,
    native_ids: set[UUID],
    owners: dict[str, UUID],
    bodies: dict[UUID, _Body],
) -> list[_Wrapper]:
    """Neutralize only proved 0292 X figures; preserve ordinary source and other embeds."""
    from lxml.html import Element

    wrapper_ids = list(
        db.scalars(
            sa.text(
                "SELECT DISTINCT media_id FROM document_embeds WHERE provider='x' AND NOT(media_id=ANY(:ids))"
            ),
            {"ids": list(native_ids)},
        )
    )
    wrappers = []
    for media_id in wrapper_ids:
        media = db.execute(
            sa.text(
                "SELECT kind,canonical_source_url,requested_url FROM media WHERE id=:id"
            ),
            {"id": media_id},
        ).one()
        if media.kind != "web_article":
            _stop(
                "X slot has unsupported source kind", media_id=media_id, kind=media.kind
            )
        source_key = f"web:{media_id}"
        owners[source_key] = media_id
        embeds = [
            dict(r)
            for r in db.execute(
                sa.text(
                    "SELECT * FROM document_embeds WHERE media_id=:id ORDER BY ordinal"
                ),
                {"id": media_id},
            ).mappings()
        ]
        for embed in embeds:
            if embed["provider"] != "x":
                continue
            ids = {
                identity.provider_id
                for url in (embed["source_url"], embed["canonical_source_url"])
                if url and (identity := classify_x_url(url)) is not None
            }
            if embed["provider_target_ref"]:
                ids.add(embed["provider_target_ref"].removeprefix("post:"))
            if len(ids) != 1 or not next(iter(ids)).isdecimal():
                _stop(
                    "generic X slot has contradictory or missing revision evidence",
                    embed_id=embed["id"],
                    revision_ids=sorted(ids),
                )
            revision_id = ids.pop()
            target = embed["target_media_id"]
            if target is not None and target not in native_ids:
                _stop(
                    "generic X embed has no normalized target evidence",
                    embed_id=embed["id"],
                    target_media_id=target,
                )
            if target in native_ids:
                claimed = db.scalar(
                    sa.text(
                        "SELECT payload->>'requested_post_id' FROM x_source_snapshots WHERE media_id=:id AND payload->>'source_kind'='post'"
                    ),
                    {"id": target},
                )
                if claimed is not None and claimed != revision_id:
                    _stop(
                        "generic X slot contradicts canonical singleton alias",
                        embed_id=embed["id"],
                        revision_id=revision_id,
                        target_revision_id=claimed,
                    )
            embed["provider_target_ref"] = revision_id
            embed["canonical_source_url"] = _url(revision_id)
            embed["source_url"] = _url(revision_id)
            embed["new_target_media_id"] = owners.get(revision_id)
            if target is not None and revision_id not in owners:
                _stop(
                    "generic X slot cannot prove target post revision",
                    embed_id=embed["id"],
                    revision_id=revision_id,
                )
        prepared_fragments = []
        fragment_ids = []
        for fragment in db.execute(
            sa.text("SELECT * FROM fragments WHERE media_id=:id ORDER BY idx"),
            {"id": media_id},
        ).mappings():
            fragment_id, old = fragment["id"], fragment["canonical_text"]
            root = parse_html_document(fragment["html_sanitized"])
            marked = root.xpath('.//figure[@data-nexus-document-embed-kind="x_post"]')
            bound = [e for e in embeds if e["fragment_id"] == fragment_id]
            slots = {e["occurrence_key"]: e for e in bound if e["provider"] == "x"}
            if len({e.get("data-nexus-document-embed-id") for e in marked}) != len(
                marked
            ):
                _stop(
                    "repeated old X figure key",
                    media_id=media_id,
                    fragment_id=fragment_id,
                )
            # The old placeholder binder could miss whitespace-normalized captions.
            # Recover exact figure bounds in a detached projection of the old HTML.
            # Removing only the new exclusion marker reproduces the old text walk;
            # the entire result must equal the immutable stored canonical source.
            projection = parse_html_document(fragment["html_sanitized"])
            projected = projection.xpath(
                './/figure[@data-nexus-document-embed-kind="x_post"]'
            )
            projection_keys = {}
            for index, figure in enumerate(projected):
                key = f"nexus-migration-x-figure-{index}"
                projection_keys[figure.get("data-nexus-document-embed-id")] = key
                figure.attrib.pop("data-nexus-document-embed-kind")
                figure.set("id", key)
            structure = canonicalize_structure(inner_html(projection.body))
            if structure.text != old:
                _stop(
                    "old generic HTML does not prove its full canonical source",
                    media_id=media_id,
                    fragment_id=fragment_id,
                )
            regions: list[_Region] = []
            for figure in marked:
                key = figure.get("data-nexus-document-embed-id")
                embed = slots.get(key)
                if embed is None:
                    _stop(
                        "X figure lacks its exact embed artifact",
                        media_id=media_id,
                        fragment_id=fragment_id,
                        occurrence_key=key,
                    )
                caption = generate_canonical_text(inner_html(figure))
                anchor_index = structure.anchors.get(projection_keys[key])
                if anchor_index is None:
                    _stop(
                        "old X figure has no visible source boundary",
                        fragment_id=fragment_id,
                        embed_id=embed["id"],
                    )
                element = structure.elements[anchor_index]
                a, b = element.start_offset, element.end_offset
                while a < b and old[a].isspace():
                    a += 1
                while b > a and old[b - 1].isspace():
                    b -= 1
                if not (0 <= a <= b <= len(old) and old[a:b] == caption):
                    _stop(
                        "X caption boundary does not match old artifact",
                        media_id=media_id,
                        fragment_id=fragment_id,
                        embed_id=embed["id"],
                    )
                prior = embed["canonical_start_offset"], embed["canonical_end_offset"]
                if prior != (None, None) and prior != (a, b):
                    _stop(
                        "old X artifact bounds contradict its exact figure",
                        fragment_id=fragment_id,
                        embed_id=embed["id"],
                        artifact_bounds=prior,
                        figure_bounds=(a, b),
                    )
                revision_id = embed["provider_target_ref"]
                regions.append(
                    _Region(
                        revision_id
                        if revision_id in owners
                        else f"unknown:{embed['id']}",
                        revision_id,
                        "embedded",
                        a,
                        b,
                        key,
                    )
                )
                # Only generated X figure descendants are discarded. Its attributes,
                # surrounding prose, and tail remain; the marker owns a zero-width slot.
                figure.text = None
                for child in list(figure):
                    figure.remove(child)
                anchor = Element("a", href=_url(revision_id))
                anchor.text = "Open on x"
                figure.append(anchor)
            missing = [
                e["id"]
                for e in slots.values()
                if e["canonical_start_offset"] is not None
                and e["occurrence_key"] not in {r.occurrence_key for r in regions}
            ]
            if missing:
                _stop(
                    "bound X artifact lacks its source figure",
                    media_id=media_id,
                    embed_ids=missing,
                )
            regions.sort(key=lambda r: (r.start, r.end))
            html = (
                inner_html(root.body)
                if root.body is not None
                else fragment["html_sanitized"]
            )
            url = (
                media.canonical_source_url
                or media.requested_url
                or "https://nexus.invalid/"
            )
            prepared = writes.prepare_article(
                html,
                base_url=url,
                document_url=url,
                extract_embeds=True,
                fragment_idx=fragment["idx"],
            )
            offsets = _source_offsets(
                old,
                [(r.start, r.end) for r in regions],
                prepared.canonical_text,
                fragment_id=fragment_id,
            )
            start = 0
            all_regions: list[_Region] = []
            for region in regions:
                if start < region.start:
                    all_regions.append(
                        _Region(source_key, source_key, "document", start, region.start)
                    )
                all_regions.append(region)
                start = region.end
            if start < len(old):
                all_regions.append(
                    _Region(source_key, source_key, "document", start, len(old))
                )
            bodies[fragment_id] = _Body(media_id, old, tuple(all_regions), offsets)
            new_slots = canonicalize_structure(prepared.html_sanitized).x_embed_slots
            for embed in bound:
                if embed["provider"] == "x":
                    slot = new_slots.get(embed["occurrence_key"])
                    embed["new_start"] = embed["new_end"] = slot
                else:
                    a, b = (
                        embed["canonical_start_offset"],
                        embed["canonical_end_offset"],
                    )
                    if (
                        a is not None
                        and b is not None
                        and (a not in offsets or b not in offsets)
                    ):
                        _stop(
                            "cannot preserve other provider slot after X caption removal",
                            embed_id=embed["id"],
                            fragment_id=fragment_id,
                        )
                    embed["new_start"] = offsets.get(a)
                    embed["new_end"] = offsets.get(b)
            prepared_fragments.append((prepared, html))
            fragment_ids.append(fragment_id)
        if not fragment_ids:
            _stop("generic X wrapper has no source fragments", media_id=media_id)
        wrappers.append(
            _Wrapper(
                media_id, tuple(fragment_ids), tuple(prepared_fragments), tuple(embeds)
            )
        )
    return wrappers


def _owner(
    bodies: dict[UUID, _Body],
    *,
    media_id: UUID,
    exact: str,
    locator: dict[str, Any] | None,
    label: str,
) -> str:
    """Location may fail; canonical source identity must be proved before any deletion."""
    locator = locator or {}
    fragment_id = locator.get("fragment_id")
    body = bodies.get(UUID(str(fragment_id))) if fragment_id else None
    if body is not None and body.media_id != media_id:
        _stop(
            "locator contradicts its media owner",
            item=label,
            media_id=media_id,
            fragment_id=fragment_id,
        )
    candidates = (
        [body]
        if body is not None
        else [b for b in bodies.values() if b.media_id == media_id]
    )
    owners: set[str] = set()
    for candidate in candidates:
        start, end = locator.get("start_offset"), locator.get("end_offset")
        if not (
            isinstance(start, int)
            and isinstance(end, int)
            and 0 <= start < end <= len(candidate.text)
            and tq.normalize_for_match(candidate.text[start:end]).text.strip()
            == tq.normalize_for_match(exact).text.strip()
        ):
            found = _match(
                candidate.text,
                exact,
                locator.get("prefix") or "",
                locator.get("suffix") or "",
            )
            if found is None:
                continue
            start, end = found
        regions = [r for r in candidate.regions if r.start < end and r.end > start]
        owners.update(r.revision for r in regions)
    if len(owners) == 1 and not next(iter(owners)).startswith("unknown:"):
        return owners.pop()
    if not owners:
        # An obsolete fragment locator can still prove a sole source. Mixed-source
        # fragments/documents never get this inference.
        only = {r.revision for b in candidates for r in b.regions}
        if len(only) == 1 and not next(iter(only)).startswith("unknown:"):
            return only.pop()
    _stop(
        "source attribution is unprovable or crosses posts",
        item=label,
        media_id=media_id,
        fragment_id=fragment_id,
        candidate_revision_ids=sorted(owners),
    )
    raise AssertionError("unreachable")


def _load(
    connection: sa.Connection,
) -> tuple[list[_Capture], dict[UUID, _Body], dict[str, tuple[_Post, _Capture]]]:
    # Locks verify quiescence at the data boundary. Release orchestration must also
    # stop old processes so they cannot resume old-schema writes after this commit.
    connection.execute(
        sa.text(
            "LOCK TABLE media, media_source_attempts, background_jobs, x_source_snapshots, fragments, highlights, highlight_fragment_anchors, reader_media_state, resource_edges, message_retrievals, messages, passage_anchors, document_embeds IN SHARE ROW EXCLUSIVE MODE NOWAIT"
        )
    )
    unsettled = list(
        connection.execute(
            sa.text("""
        SELECT a.id, a.media_id, a.status, a.job_id FROM media_source_attempts a
        LEFT JOIN background_jobs j ON j.id=a.job_id
        WHERE (a.provider='x' OR a.source_type IN ('x_post','x_author_thread'))
          AND (a.status IN ('accepted','queued','running') OR j.status NOT IN ('succeeded','dead'))
    """)
        ).mappings()
    )
    if unsettled:
        _stop(
            "unsettled X source work; stop and settle writers",
            attempts=[dict(r) for r in unsettled],
        )
    missing = list(
        connection.scalars(
            sa.text("""
        SELECT m.id FROM media m
        WHERE (m.provider='x' OR EXISTS (SELECT 1 FROM media_source_attempts a WHERE a.media_id=m.id AND a.source_type IN ('x_post','x_author_thread')))
          AND (EXISTS (SELECT 1 FROM reader_publications p WHERE p.media_id=m.id)
               OR EXISTS (SELECT 1 FROM fragments f WHERE f.media_id=m.id))
          AND NOT EXISTS (SELECT 1 FROM x_source_snapshots s WHERE s.media_id=m.id)
        ORDER BY m.id
    """)
        )
    )
    if missing:
        _stop("published X lacks normalized source evidence", media_ids=missing)
    captures = []
    latest: dict[str, tuple[_Post, _Capture]] = {}
    singleton: dict[str, UUID] = {}
    bodies: dict[UUID, _Body] = {}
    for row in connection.execute(
        sa.text("""
        SELECT s.*, m.created_by_user_id, m.kind, m.provider, a.media_id AS attempt_media_id,
               a.status AS attempt_status, a.source_type, a.created_by_user_id AS actor_id, p.generation
        FROM x_source_snapshots s JOIN media m ON m.id=s.media_id
        JOIN media_source_attempts a ON a.id=s.source_attempt_id
        LEFT JOIN reader_publications p ON p.media_id=s.media_id
        ORDER BY s.published_at, s.media_id
    """)
    ).mappings():
        try:
            snapshot = _Snapshot.model_validate_json(json.dumps(row["payload"]))
        except ValidationError as exc:
            _stop(
                "malformed normalized snapshot",
                media_id=row["media_id"],
                snapshot_id=row["id"],
                errors=exc.errors(
                    include_url=False, include_context=False, include_input=False
                ),
            )
        if (
            row["kind"] != "web_article"
            or row["provider"] != "x"
            or row["generation"] is None
        ):
            _stop("snapshot has no valid X publication", media_id=row["media_id"])
        if (
            row["attempt_media_id"] != row["media_id"]
            or row["attempt_status"] != "succeeded"
            or row["source_type"]
            != ("x_post" if snapshot.source_kind == "post" else "x_author_thread")
        ):
            _stop(
                "source attempt ownership/status/scope contradicts capture",
                media_id=row["media_id"],
                attempt_id=row["source_attempt_id"],
            )
        viewer_id = row["created_by_user_id"] or row["actor_id"]
        if viewer_id is None:
            _stop(
                "capture has no contributor/publication actor", media_id=row["media_id"]
            )
        capture = _Capture(
            row["media_id"],
            row["source_attempt_id"],
            row["published_at"],
            viewer_id,
            row["generation"],
            snapshot,
        )
        captures.append(capture)
        if snapshot.source_kind == "post":
            previous = singleton.setdefault(
                snapshot.requested_post_id, capture.media_id
            )
            if previous != capture.media_id:
                _stop(
                    "exact revision has conflicting existing canonical owners",
                    revision_id=snapshot.requested_post_id,
                    media_ids=[previous, capture.media_id],
                )
        for identity, post in snapshot.posts.items():
            previous = latest.get(identity)
            if previous is not None and (
                previous[0].author.id != post.author.id
                or previous[0].text != post.text
                or sorted((r.kind, r.post_id) for r in previous[0].references)
                != sorted((r.kind, r.post_id) for r in post.references)
                or sorted(a.media_key for a in previous[0].attachments)
                != sorted(a.media_key for a in post.attachments)
            ):
                _stop(
                    "exact revision has contradictory author/text/references/attachments",
                    revision_id=identity,
                    media_ids=[previous[1].media_id, capture.media_id],
                )
            latest[identity] = post, capture
        fragments = list(
            connection.execute(
                sa.text(
                    "SELECT id,idx,canonical_text FROM fragments WHERE media_id=:id ORDER BY idx"
                ),
                {"id": capture.media_id},
            )
        )
        if [f.idx for f in fragments] != list(range(len(snapshot.primary_post_ids))):
            _stop(
                "fragment ordinals do not prove primary source ownership",
                media_id=capture.media_id,
                fragment_ids=[f.id for f in fragments],
            )
        for fragment in fragments:
            try:
                regions = _old_regions(snapshot, fragment.idx, fragment.canonical_text)
            except RuntimeError as exc:
                _stop(
                    "unproved old rendered boundaries",
                    media_id=capture.media_id,
                    fragment_id=fragment.id,
                    error=str(exc),
                )
            bodies[fragment.id] = _Body(
                capture.media_id, fragment.canonical_text, regions
            )
    affected = [c.media_id for c in captures]
    for row in connection.execute(
        sa.text(
            "SELECT id,provider_id FROM media WHERE provider='x' AND provider_id LIKE 'post:%'"
        )
    ):
        alias = row.provider_id.removeprefix("post:")
        if alias in latest and singleton.get(alias) != row.id:
            _stop(
                "existing exact alias owner lacks matching singleton proof",
                revision_id=alias,
                media_id=row.id,
                normalized_owner_id=singleton.get(alias),
            )
    work = list(
        connection.scalars(
            sa.text(
                "SELECT id FROM background_jobs WHERE status='running' AND payload->>'media_id'=ANY(:ids)"
            ),
            {"ids": [str(i) for i in affected]},
        )
    )
    teardown = list(
        connection.scalars(
            sa.text(
                "SELECT media_id FROM media_teardown_intents WHERE media_id=ANY(:ids)"
            ),
            {"ids": affected},
        )
    )
    if work or teardown:
        _stop(
            "active derived work or teardown blocks conversion",
            job_ids=work,
            teardown_media_ids=teardown,
        )
    return captures, bodies, latest


def _create_schema() -> None:
    op.create_table(
        "x_post_sources",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "media_id", PG_UUID(as_uuid=True), sa.ForeignKey("media.id"), nullable=False
        ),
        sa.Column(
            "source_attempt_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media_source_attempts.id"),
            nullable=False,
        ),
        sa.Column("source_revision_id", sa.Text, nullable=False),
        sa.Column("logical_post_id", sa.Text, nullable=True),
        sa.Column("edit_history_ids", JSONB, nullable=True),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("availability", sa.Text, nullable=False),
        sa.Column("body_captured_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("checked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.UniqueConstraint("media_id"),
    )
    op.create_table(
        "x_post_aliases",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column("revision_id", sa.Text, nullable=False),
        sa.Column(
            "post_media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id"),
            nullable=False,
        ),
        sa.UniqueConstraint("revision_id", name="x_post_aliases_revision_id_key"),
    )
    op.create_index(
        "ix_x_post_aliases_post_media_id", "x_post_aliases", ["post_media_id"]
    )
    op.create_table(
        "x_thread_sources",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "media_id", PG_UUID(as_uuid=True), sa.ForeignKey("media.id"), nullable=False
        ),
        sa.Column(
            "source_attempt_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media_source_attempts.id"),
            nullable=False,
        ),
        sa.Column("author_id", sa.Text, nullable=False),
        sa.Column(
            "root_post_media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id"),
            nullable=True,
        ),
        sa.Column(
            "published_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("membership_checked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("coverage", JSONB, nullable=False),
        sa.UniqueConstraint("media_id"),
    )
    op.create_table(
        "x_thread_posts",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "thread_media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id"),
            nullable=False,
        ),
        sa.Column(
            "post_media_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media.id"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer, nullable=False),
        sa.UniqueConstraint("thread_media_id", "post_media_id"),
        sa.UniqueConstraint("thread_media_id", "ordinal"),
    )
    op.create_index(
        "ix_x_thread_posts_post_media_id", "x_thread_posts", ["post_media_id"]
    )
    op.alter_column("reader_media_state", "locator", new_column_name="cursor")
    op.execute(
        "UPDATE reader_media_state SET cursor=jsonb_build_object('tag','Positioned','locator',cursor) WHERE cursor IS NOT NULL"
    )
    op.drop_index("uix_media_x_provider_id", table_name="media")


def _thread_facts(
    capture: _Capture, posts: dict[str, tuple[_Post, _Capture]]
) -> tuple[list[str], str | None, list[str]]:
    primary = capture.source.primary_post_ids
    author = capture.source.posts[primary[0]].author.id
    if any(posts[p][0].author.id != author for p in primary):
        _stop(
            "one thread combines different primary authors",
            media_id=capture.media_id,
            revision_ids=primary,
        )
    roots: set[str] = set()
    unresolved: set[str] = set()
    for identity in primary:
        seen: set[str] = set()
        current = identity
        while True:
            if current in seen:
                _stop(
                    "reply graph has a cycle",
                    media_id=capture.media_id,
                    revision_ids=sorted(seen),
                )
            seen.add(current)
            post = posts[current][0]
            replies = [r.post_id for r in post.references if r.kind == "replied_to"]
            if len(replies) > 1:
                _stop("post has contradictory reply parents", revision_id=current)
            if not replies:
                roots.add(current)
                break
            parent = replies[0]
            if parent not in posts:
                unresolved.add(parent)
                break
            if posts[parent][0].author.id != author:
                roots.add(current)
                break
            current = parent
    if len(roots) > 1:
        _stop(
            "one published document combines proved disconnected author components",
            media_id=capture.media_id,
            root_revision_ids=sorted(roots),
        )
    ordered: list[str] = []
    remaining = set(primary)
    while remaining:
        ready = sorted(
            (
                p
                for p in remaining
                if not any(
                    r.kind == "replied_to" and r.post_id in remaining
                    for r in posts[p][0].references
                )
            ),
            key=int,
        )
        if not ready:
            _stop("primary reply graph has a cycle", media_id=capture.media_id)
        first = ready[0]
        ordered.append(first)
        remaining.remove(first)
    root = next(iter(roots)) if len(roots) == 1 and not unresolved else None
    # A proved ancestor outside the retained primary set is context, not an invented member.
    return ordered, root if root in primary else None, sorted(unresolved, key=int)


def _evidence_owner(
    raw: dict[str, Any], *, bodies: dict[UUID, _Body], scope: set[UUID], label: str
) -> str | None:
    target = raw.get("target") or {}
    ref = target.get("owner_ref") or (raw.get("source") or {}).get("ref")
    if not isinstance(ref, str) or not ref.startswith("media:"):
        return None
    media_id = UUID(ref[6:])
    if media_id not in scope:
        return None
    quote = raw.get("quote")
    if quote is None:
        # Ordinary whole-document references retain their thread identity.
        return None
    return _owner(
        bodies,
        media_id=media_id,
        exact=quote["exact"],
        locator=target.get("locator"),
        label=label,
    )


def _located_target(
    raw: dict[str, Any],
    revision: str,
    owners: dict[str, UUID],
    fragments: dict[str, list[tuple[UUID, str]]],
) -> dict[str, Any]:
    """Only the navigable target changes. The captured quote and source stay untouched."""
    quote = raw["quote"]
    found = _current_match(
        fragments[revision],
        quote["exact"],
        quote.get("prefix") or "",
        quote.get("suffix") or "",
    )
    owner_ref = f"media:{owners[revision]}"
    if found is None:
        old = raw["target"]
        if old["kind"] == "passage":
            locator = {**old["locator"], "media_id": str(owners[revision])}
            # Retain the stale hint: the X evidence owner rematches exact words on
            # future reads. A missing current match is not lost source ownership.
            target = {**old, "owner_ref": owner_ref, "locator": locator}
        else:
            target = {"kind": "unavailable", "owner_ref": owner_ref}
    else:
        target = {
            "kind": "passage",
            "owner_ref": owner_ref,
            "precision": "exact",
            "source_identity": None,
            "locator": {
                "type": "web_text_offsets",
                "media_id": str(owners[revision]),
                "media_kind": "web_article",
                "fragment_id": str(found[0]),
                "start_offset": found[1],
                "end_offset": found[2],
                "text_quote_selector": {
                    "exact": quote["exact"],
                    "prefix": quote.get("prefix") or "",
                    "suffix": quote.get("suffix") or "",
                },
            },
        }
    return {**raw, "target": target}


def _json_update(db: Session, table: str, identity: UUID, **values: Any) -> None:
    statement = sa.text(
        f"UPDATE {table} SET "
        + ",".join(f"{key}=:{key}" for key in values)
        + " WHERE id=:id"
    )
    for key, value in values.items():
        if isinstance(value, (dict, list)):
            statement = statement.bindparams(sa.bindparam(key, type_=JSONB))
    db.execute(statement, {"id": identity, **values})


def _rebind_saved(
    db: Session,
    *,
    scope: set[UUID],
    bodies: dict[UUID, _Body],
    owners: dict[str, UUID],
    fragments: dict[str, list[tuple[UUID, str]]],
    derived: dict[tuple[str, UUID], tuple[UUID, str, dict[str, Any] | None]],
) -> None:
    # A whole-media search result may freeze the thread's description. Its
    # explicit result identity and exact retained metadata prove thread ownership;
    # it is not an unlocated claim to some constituent post's authored words.
    whole_retrievals: set[UUID] = set()
    whole_citations: dict[UUID, tuple[UUID, UUID, dict[str, Any], str]] = {}
    for row in db.execute(
        sa.text("""SELECT r.*,m.description,m.title AS media_title,m.kind AS media_kind
            FROM message_retrievals r JOIN media m ON m.id=r.media_id
            WHERE r.result_type='media' AND r.media_id=ANY(:ids)"""),
        {"ids": list(scope)},
    ).mappings():
        evidence = row["captured_evidence"]
        quote = evidence.get("quote")
        target = evidence.get("target") or {}
        identity = str(row["media_id"])
        result = row["result_ref"]
        context = row["context_ref"]
        if (
            quote is not None
            and quote["exact"] in (row["description"], row["media_title"])
            and row["exact_snippet"] == quote["exact"]
            and row["source_id"] == identity
            and context == {"type": "media", "id": identity}
            and result.get("type") == "media"
            and result.get("id") == identity
            and result.get("citation_target") == f"media:{identity}"
            and evidence["source"]["ref"] == f"media:{identity}"
            and target == {"kind": "unavailable", "owner_ref": f"media:{identity}"}
        ):
            whole_retrievals.add(row["id"])
            if row["cited_edge_id"] is not None:
                proof = (
                    row["assistant_message_id"],
                    row["media_id"],
                    evidence,
                    row["media_kind"],
                )
                previous = whole_citations.get(row["cited_edge_id"])
                if previous is not None and previous != proof:
                    _stop(
                        "whole-media retrievals disagree on their citation capture",
                        citation_id=row["cited_edge_id"],
                        retrieval_id=row["id"],
                    )
                whole_citations[row["cited_edge_id"]] = proof

    highlights: dict[UUID, str] = {}
    for row in db.execute(
        sa.text("""
        SELECT h.id,h.anchor_media_id,h.exact,h.prefix,h.suffix,a.fragment_id,a.start_offset,a.end_offset
        FROM highlights h LEFT JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
        WHERE h.anchor_media_id=ANY(:ids)
    """),
        {"ids": list(scope)},
    ).mappings():
        revision = _owner(
            bodies,
            media_id=row["anchor_media_id"],
            exact=row["exact"],
            locator=dict(row),
            label=f"highlight:{row['id']}",
        )
        highlights[row["id"]] = revision
        _json_update(db, "highlights", row["id"], anchor_media_id=owners[revision])
        found = _current_match(
            fragments[revision], row["exact"], row["prefix"], row["suffix"]
        )
        if found is not None:
            db.execute(
                sa.text(
                    "UPDATE highlight_fragment_anchors SET fragment_id=:f,start_offset=:s,end_offset=:e WHERE highlight_id=:id"
                ),
                {"id": row["id"], "f": found[0], "s": found[1], "e": found[2]},
            )
    anchors: dict[tuple[UUID, UUID, str], UUID] = {}
    anchor_moves: list[tuple[UUID, UUID, dict[str, Any]]] = []
    for row in db.execute(sa.text("SELECT * FROM passage_anchors")).mappings():
        owner_id = row["owner_id"]
        if row["owner_scheme"] == "media" and owner_id in scope:
            quote = row["selector"]["quote"]
            revision = _owner(
                bodies,
                media_id=owner_id,
                exact=quote["exact"],
                locator=row["selector"].get("locator_hint"),
                label=f"passage_anchor:{row['id']}",
            )
            owner_id = owners[revision]
            found = _current_match(
                fragments[revision],
                quote["exact"],
                quote.get("prefix") or "",
                quote.get("suffix") or "",
            )
            hint = (
                {
                    "kind": "text",
                    "fragment_id": str(found[0]),
                    "start_offset": found[1],
                    "end_offset": found[2],
                }
                if found
                else None
            )
            anchor_moves.append(
                (row["id"], owner_id, {**row["selector"], "locator_hint": hint})
            )
        if row["owner_scheme"] == "media":
            key = row["user_id"], owner_id, row["anchor_key"]
            if key in anchors:
                _stop(
                    "canonical source conversion collides durable passage identities",
                    passage_anchor_ids=[anchors[key], row["id"]],
                    media_id=owner_id,
                )
            anchors[key] = row["id"]
    for identity, owner_id, selector in anchor_moves:
        _json_update(
            db, "passage_anchors", identity, owner_id=owner_id, selector=selector
        )

    # Bare links to disposable X passages need a durable quote before indexing clears them.
    def durable_ref(scheme: str, identity: UUID, user_id: UUID) -> tuple[str, UUID]:
        value = derived.get((scheme, identity))
        if value is None:
            return scheme, identity
        old_owner, exact, locator = value
        revision = _owner(
            bodies,
            media_id=old_owner,
            exact=exact,
            locator=locator,
            label=f"{scheme}:{identity}",
        )
        owner_id = owners[revision]
        normalized = normalize_quote_text(exact)
        key = compute_anchor_key(exact=normalized, prefix="", suffix="")
        existing = anchors.get((user_id, owner_id, key))
        if existing is not None:
            return "passage_anchor", existing
        found = _current_match(fragments[revision], normalized)
        hint = (
            {
                "kind": "text",
                "fragment_id": str(found[0]),
                "start_offset": found[1],
                "end_offset": found[2],
            }
            if found
            else None
        )
        identity = new_uuid7()
        db.execute(
            sa.text("""INSERT INTO passage_anchors(id,user_id,owner_scheme,owner_id,anchor_key,selector)
            VALUES (:id,:user_id,'media',:owner_id,:key,:selector)""").bindparams(
                sa.bindparam("selector", type_=JSONB)
            ),
            {
                "id": identity,
                "user_id": user_id,
                "owner_id": owner_id,
                "key": key,
                "selector": {
                    "quote": {"exact": normalized, "prefix": "", "suffix": ""},
                    "locator_hint": hint,
                },
            },
        )
        anchors[user_id, owner_id, key] = identity
        return "passage_anchor", identity

    for row in db.execute(sa.text("SELECT * FROM resource_edges")).mappings():
        updates: dict[str, Any] = {}
        snapshot = row["snapshot"]
        evidence = snapshot.get("evidence") if isinstance(snapshot, dict) else None
        whole = whole_citations.get(row["id"])
        if (
            evidence is not None
            and row["origin"] == "citation"
            and row["kind"] == "context"
            and row["ordinal"] is not None
            and row["source_scheme"] == "message"
            and row["target_scheme"] == "media"
            and whole is not None
            and whole[:2] == (row["source_id"], row["target_id"])
        ):
            retrieved = whole[2]
            same_capture = evidence == retrieved
            if (
                not same_capture
                and evidence["source"]["media_kind"] is None
                and retrieved["source"]["media_kind"] == whole[3]
            ):
                # A null kind in the directly linked citation is unknown, not a
                # contradictory kind. Compare every other frozen field exactly;
                # neither stored evidence value is normalized or rewritten.
                same_capture = {
                    **evidence,
                    "source": {
                        k: v for k, v in evidence["source"].items() if k != "media_kind"
                    },
                } == {
                    **retrieved,
                    "source": {
                        k: v
                        for k, v in retrieved["source"].items()
                        if k != "media_kind"
                    },
                }
            if same_capture:
                continue
        if whole is not None:
            _stop(
                "whole-media citation contradicts its linked retrieval",
                citation_id=row["id"],
                assistant_message_id=whole[0],
                media_id=whole[1],
            )
        if row["origin"] == "document_embed":
            continue
        if (
            row["origin"] == "discovery"
            and row["ordinal"] is None
            and isinstance(snapshot, dict)
            and snapshot.get("evidence") is None
        ):
            # Generated proposals have the disposable index's lifecycle. Existing
            # index cleanup removes them; captured evidence and user links below
            # still require attributable durable owners before anything is cleared.
            continue
        revision = (
            _evidence_owner(
                evidence, bodies=bodies, scope=scope, label=f"citation:{row['id']}"
            )
            if evidence is not None
            else None
        )
        if revision is not None:
            updates["snapshot"] = {
                **snapshot,
                "evidence": _located_target(evidence, revision, owners, fragments),
            }
            if row["target_scheme"] in (
                "media",
                "fragment",
                "content_chunk",
                "evidence_span",
                "reader_apparatus_item",
            ):
                updates.update(target_scheme="media", target_id=owners[revision])
        for side in ("source", "target"):
            if f"{side}_id" in updates:
                continue
            ref = row[f"{side}_scheme"], row[f"{side}_id"]
            rebound = durable_ref(*ref, row["user_id"])
            if rebound != ref:
                updates.update({f"{side}_scheme": rebound[0], f"{side}_id": rebound[1]})
        if updates:
            _json_update(db, "resource_edges", row["id"], **updates)

    for row in db.execute(sa.text("SELECT * FROM message_retrievals")).mappings():
        if row["id"] in whole_retrievals:
            continue
        evidence = row["captured_evidence"]
        revision = _evidence_owner(
            evidence, bodies=bodies, scope=scope, label=f"retrieval:{row['id']}"
        )
        if revision is None:
            if row["media_id"] in scope and evidence.get("quote") is not None:
                _stop(
                    "retrieval owner contradicts its captured target",
                    retrieval_id=row["id"],
                    media_id=row["media_id"],
                )
            continue
        rebound = _located_target(evidence, revision, owners, fragments)
        raw_locator = row["locator"]
        if raw_locator is not None:
            raw_locator = rebound["target"].get("locator")
        result = dict(row["result_ref"])
        if "media_id" in result:
            result["media_id"] = str(owners[revision])
        if result.get("locator") is not None and raw_locator is not None:
            result["locator"] = raw_locator
        # Historical result identity, labels and wording remain; the explicit target
        # is the durable canonical owner, independent of the disposable result row.
        if "citation_target" in result:
            result["citation_target"] = f"media:{owners[revision]}"
        _json_update(
            db,
            "message_retrievals",
            row["id"],
            captured_evidence=rebound,
            media_id=owners[revision],
            locator=raw_locator,
            result_ref=result,
        )
    for row in db.execute(
        sa.text(
            "SELECT id,reader_selection_snapshot FROM messages WHERE reader_selection_snapshot IS NOT NULL"
        )
    ).mappings():
        snapshot = row["reader_selection_snapshot"]
        key = snapshot["key"]
        known = highlights.get(UUID(key["highlight_id"]))
        revision = _evidence_owner(
            snapshot["evidence"],
            bodies=bodies,
            scope=scope,
            label=f"reader_quote:{row['id']}",
        )
        if revision is None:
            continue
        _json_update(
            db,
            "messages",
            row["id"],
            reader_selection_snapshot={
                **snapshot,
                "key": {**key, "media_id": str(owners[known or revision])},
                "evidence": _located_target(
                    snapshot["evidence"], revision, owners, fragments
                ),
            },
        )


def _remap_cursors(
    db: Session,
    *,
    scope: set[UUID],
    bodies: dict[UUID, _Body],
    owners: dict[str, UUID],
    fragments: dict[str, list[tuple[UUID, str]]],
    embeds: list[dict[str, Any]],
    replacements: dict[UUID, UUID],
) -> None:
    validator = TypeAdapter(StoredReaderCursor)
    for row in db.execute(
        sa.text("""SELECT id,media_id,cursor FROM reader_media_state
        WHERE cursor IS NOT NULL AND (media_id=ANY(:media_ids)
          OR cursor #>> '{locator,target,fragment_id}'=ANY(:fragment_ids))"""),
        {"media_ids": list(scope), "fragment_ids": [str(f) for f in bodies]},
    ).mappings():
        before = row["cursor"]["locator"]
        if before.get("kind") != "web":
            continue
        fragment_id = UUID(before["target"]["fragment_id"])
        old = bodies.get(fragment_id)
        offset = before["locations"]["text_offset"]
        if old is None:
            regions = []
            excerpt = before["text"]["quote"] or ""
            excerpt_offset = 0
        else:
            if offset is None:
                quote = before["text"]["quote"]
                match = (
                    _match(
                        old.text,
                        quote,
                        before["text"]["quote_prefix"] or "",
                        before["text"]["quote_suffix"] or "",
                    )
                    if quote
                    else None
                )
                offset = match[0] if match else None
            position = min(max(offset or 0, 0), len(old.text))
            start = max(0, position - 64)
            excerpt = old.text[start : position + 64]
            excerpt_offset = position - start
            regions = [
                r
                for r in old.regions
                if offset is not None and r.start <= offset < r.end
            ]
            if not regions and offset == len(old.text) and old.regions:
                regions = [old.regions[-1]]
        region = regions[0] if len(regions) == 1 else None
        revision = (
            region.revision
            if region is not None
            and region.revision.isdecimal()
            and region.revision in owners
            else None
        )
        occurrence = None
        matched_offset = None
        cursor = None
        if old is not None and region is not None and offset is not None:
            if region.relation == "document" and row["media_id"] == old.media_id:
                matched_offset = (old.source_offsets or {}).get(offset)
                if matched_offset is not None:
                    cursor = {
                        "tag": "Positioned",
                        "locator": {
                            **before,
                            "target": {"fragment_id": str(replacements[fragment_id])},
                            "locations": {
                                "text_offset": matched_offset,
                                "progression": None,
                                "total_progression": None,
                                "position": None,
                            },
                            "text": {
                                "quote": None,
                                "quote_prefix": None,
                                "quote_suffix": None,
                            },
                        },
                    }
            elif revision is not None:
                owner_id = owners[revision]
                new_text = fragments[revision][0][1]
                retained = old.text[region.start : region.end]
                start = retained.find(new_text)
                if (
                    new_text
                    and start >= 0
                    and retained.find(new_text, start + 1) == -1
                    and region.start + start
                    <= offset
                    <= region.start + start + len(new_text)
                ):
                    matched_offset = offset - region.start - start
                else:
                    a, b = max(region.start, offset - 32), min(region.end, offset + 32)
                    found = _match(new_text, old.text[a:b]) if a < b else None
                    if found is not None:
                        matched_offset = found[0] + offset - a
                if row["media_id"] == old.media_id and region.relation != "embedded":
                    parent = (
                        None
                        if region.relation == "primary"
                        else str(
                            uuid5(
                                NAMESPACE_URL,
                                f"nexus:x:{row['media_id']}::{owners[region.primary]}:primary:",
                            )
                        )
                    )
                    occurrence = str(
                        uuid5(
                            NAMESPACE_URL,
                            f"nexus:x:{row['media_id']}:{parent or ''}:{owner_id}:{region.relation}:",
                        )
                    )
                else:
                    slots = [
                        e
                        for e in embeds
                        if e["media_id"] == row["media_id"]
                        and e["new_target_media_id"] == owner_id
                        and e["new_end"] is not None
                        and (
                            region.occurrence_key is None
                            or e["occurrence_key"] == region.occurrence_key
                        )
                    ]
                    if len(slots) == 1:
                        slot = slots[0]
                        occurrence = str(
                            uuid5(
                                NAMESPACE_URL,
                                f"nexus:x:{row['media_id']}:{slot['new_fragment_id']}:{owner_id}:embedded:{slot['occurrence_key']}",
                            )
                        )
        if (
            cursor is None
            and matched_offset is not None
            and occurrence is not None
            and revision is not None
        ):
            cursor = {
                "tag": "Positioned",
                "locator": {
                    "kind": "x",
                    "occurrence_id": occurrence,
                    "post_media_id": str(owners[revision]),
                    "source_revision_id": revision,
                    "locations": {
                        "text_offset": matched_offset,
                        "progression": None,
                        "total_progression": None,
                        "position": None,
                    },
                    "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
                },
            }
        if cursor is None:
            generation = db.scalar(
                sa.text(
                    "SELECT generation FROM reader_publications WHERE media_id=:id"
                ),
                {"id": row["media_id"]},
            )
            if generation is None:
                _stop(
                    "saved cursor has no prior publication generation",
                    cursor_id=row["id"],
                    media_id=row["media_id"],
                )
            cursor = {
                "tag": "Unresolved",
                "previous_locator": before,
                "from_generation": generation,
                "post_media_id": str(owners[revision]) if revision else None,
                "source_revision_id": revision,
                "excerpt": excerpt,
                "offset_in_excerpt": excerpt_offset,
            }
        validator.validate_python(cursor)
        db.execute(
            sa.text(
                "UPDATE reader_media_state SET cursor=:cursor,revision=revision+1 WHERE id=:id"
            ).bindparams(sa.bindparam("cursor", type_=JSONB)),
            {"id": row["id"], "cursor": cursor},
        )


def upgrade() -> None:
    connection = op.get_bind()
    captures, bodies, latest = _load(connection)
    facts = {
        c.media_id: _thread_facts(c, latest)
        for c in captures
        if c.source.source_kind == "author_thread"
    }
    _create_schema()
    with Session(bind=connection) as db:
        wrappers, reindexed = _convert(db, captures, bodies, latest, facts)
    # Failed unpublished attempts keep their own identities and history, without
    # the retired author/conversation or requested-post uniqueness mechanism.
    op.execute("UPDATE media SET provider_id=NULL WHERE provider='x'")
    op.drop_table("x_source_snapshots")
    posts = len(captures) - len(facts)
    print(
        f"0293 census: {len(captures)} X snapshots ({posts} posts, {len(facts)} threads),"
        f" {len(latest)} canonical posts ({len(latest) - posts} new),"
        f" {wrappers} wrapping articles, {reindexed} media reindexed"
    )


def _convert(
    db: Session,
    captures: list[_Capture],
    bodies: dict[UUID, _Body],
    latest: dict[str, tuple[_Post, _Capture]],
    facts: dict[UUID, tuple[list[str], str | None, list[str]]],
) -> tuple[int, int]:
    by_media = {c.media_id: c for c in captures}
    singletons = {
        c.source.requested_post_id: c
        for c in captures
        if c.source.source_kind == "post"
    }
    owners = {
        p: singletons[p].media_id if p in singletons else new_uuid7() for p in latest
    }
    wrappers = _prepare_wrappers(
        db, native_ids=set(by_media), owners=owners, bodies=bodies
    )
    scope = set(by_media) | {w.media_id for w in wrappers}
    changed = scope | set(owners.values())

    # Freeze disposable passages before fragment/apparatus/index replacement.
    derived: dict[tuple[str, UUID], tuple[UUID, str, dict[str, Any] | None]] = {
        ("fragment", identity): (
            body.media_id,
            body.text,
            {
                "fragment_id": str(identity),
                "start_offset": 0,
                "end_offset": len(body.text),
            },
        )
        for identity, body in bodies.items()
    }
    for row in db.execute(
        sa.text(
            "SELECT id,owner_id,span_text,selector FROM evidence_spans WHERE owner_kind='media' AND owner_id=ANY(:ids)"
        ),
        {"ids": list(scope)},
    ):
        derived["evidence_span", row.id] = row.owner_id, row.span_text, row.selector
    for row in db.execute(
        sa.text(
            "SELECT id,owner_id,chunk_text,primary_evidence_span_id FROM content_chunks WHERE owner_kind='media' AND owner_id=ANY(:ids)"
        ),
        {"ids": list(scope)},
    ):
        span = derived.get(("evidence_span", row.primary_evidence_span_id))
        derived["content_chunk", row.id] = (
            row.owner_id,
            row.chunk_text,
            span[2] if span else None,
        )
    for row in db.execute(
        sa.text(
            "SELECT id,media_id,body_text,locator FROM reader_apparatus_items WHERE media_id=ANY(:ids)"
        ),
        {"ids": list(scope)},
    ):
        derived["reader_apparatus_item", row.id] = (
            row.media_id,
            row.body_text or "",
            row.locator,
        )

    # Include every wrapper before replacing native aggregate embed rows, including
    # ancestors of a previously unresolved generic slot that now has a proved body.
    changed.update(
        db.scalars(
            sa.text("""
        WITH RECURSIVE parents(id) AS (
            SELECT unnest(CAST(:ids AS uuid[]))
            UNION SELECT e.media_id FROM document_embeds e JOIN parents p ON p.id=e.target_media_id
            WHERE e.resolution_status='resolved'
        ) SELECT id FROM parents
    """),
            {"ids": list(changed)},
        )
    )
    running = list(
        db.scalars(
            sa.text(
                "SELECT id FROM background_jobs WHERE status='running' AND payload->>'media_id'=ANY(:ids)"
            ),
            {"ids": [str(i) for i in changed]},
        )
    )
    teardown = list(
        db.scalars(
            sa.text(
                "SELECT media_id FROM media_teardown_intents WHERE media_id=ANY(:ids)"
            ),
            {"ids": list(changed)},
        )
    )
    if running or teardown:
        _stop(
            "active work or teardown on a containing publication",
            job_ids=running,
            teardown_media_ids=teardown,
        )

    sources: dict[str, tuple[UUID, UUID, XSourcePost]] = {}
    fragments: dict[str, list[tuple[UUID, str]]] = {}
    for revision, (old_post, capture) in latest.items():
        reply = next(
            (r.post_id for r in old_post.references if r.kind == "replied_to"), None
        )
        body = XPostContent.model_validate_json(
            json.dumps(
                {
                    **old_post.model_dump(mode="json", exclude={"id", "references"}),
                    "conversation_id": None,
                    "in_reply_to_user_id": latest[reply][0].author.id
                    if reply in latest
                    else None,
                    "references": [
                        {"kind": r.kind, "target_revision_id": r.post_id}
                        for r in old_post.references
                    ],
                }
            )
        )
        post = XSourcePost(
            source_revision_id=revision,
            logical_post_id=None,
            edit_history_ids=None,
            content=body,
            availability="available",
            body_captured_at=None,
            checked_at=None,
        )
        url = _url(revision)
        media_id = owners[revision]
        collision = db.scalar(
            sa.text("SELECT id FROM media WHERE canonical_url=:url AND id<>:id"),
            {"url": url, "id": media_id},
        )
        if collision is not None:
            _stop(
                "canonical permalink has another existing owner",
                revision_id=revision,
                media_ids=[media_id, collision],
            )
        exists = db.scalar(
            sa.text("SELECT 1 FROM media WHERE id=:id"), {"id": media_id}
        )
        if exists is None:
            db.execute(
                sa.text("""INSERT INTO media (id, kind, title, description, language,
                    publisher, provider, created_by_user_id, requested_url, processing_status)
                    VALUES (:id, 'web_article', :title, :description, :language, 'X', 'x',
                    :viewer, :url, 'ready_for_reading')"""),
                {
                    "id": media_id,
                    "title": post_label(post),
                    "description": body.text[:2000],
                    "language": body.language,
                    "viewer": capture.viewer_id,
                    "url": url,
                },
            )
        prior = singletons.get(revision)
        if prior is not None:
            attempt_id = prior.attempt_id
        else:
            attempt_id = new_uuid7()
            writes.create_succeeded_x_post_attempt(
                db,
                attempt_id=attempt_id,
                media_id=media_id,
                actor_id=capture.viewer_id,
                url=url,
                revision_id=revision,
                parent_attempt_id=capture.attempt_id,
            )
        db.execute(
            sa.text("""UPDATE media SET provider_id=NULL, canonical_url=:url,
                canonical_source_url=:url WHERE id=:id"""),
            {"url": url, "id": media_id},
        )
        db.execute(
            sa.text("""INSERT INTO x_post_sources (id, media_id, source_attempt_id,
                source_revision_id, logical_post_id, edit_history_ids, payload, availability,
                body_captured_at, checked_at)
                VALUES (:id, :media, :attempt, :revision, NULL, NULL, CAST(:payload AS jsonb),
                'available', NULL, NULL)"""),
            {
                "id": new_uuid7(),
                "media": media_id,
                "attempt": attempt_id,
                "revision": revision,
                "payload": json.dumps(body.model_dump(mode="json")),
            },
        )
        db.execute(
            sa.text("""INSERT INTO x_post_aliases (id, revision_id, post_media_id)
                VALUES (:id, :revision, :media)"""),
            {"id": new_uuid7(), "revision": revision, "media": media_id},
        )
        sources[revision] = media_id, attempt_id, post
        html = render_post(post)
        prepared = writes.prepare_article(
            html, base_url=url, document_url=url, extract_embeds=False
        )
        [fragment_id] = writes.replace_article_fragments(
            db, media_id=media_id, fragments=[(prepared, html)]
        )
        fragments[revision] = [(fragment_id, prepared.canonical_text)]
        observation, _ = build_observation(
            {
                "author": [
                    RawCreditEntry(
                        credited_name=body.author.name or f"@{body.author.username}",
                        identity_claims=(RawIdentityClaim("x_user", body.author.id),),
                    )
                ]
            }
        )
        writes.apply_observed_media_credits(
            db, media_id=media_id, observation=observation, source="x_api_post"
        )

    for capture in captures:
        if capture.source.source_kind != "author_thread":
            continue
        ordered, root, unresolved = facts[capture.media_id]
        db.execute(
            sa.text("""INSERT INTO x_thread_sources (id, media_id, source_attempt_id,
                author_id, root_post_media_id, published_at, membership_checked_at, coverage)
                VALUES (:id, :media, :attempt, :author, :root, :published_at, NULL,
                CAST(:coverage AS jsonb))"""),
            {
                "id": new_uuid7(),
                "media": capture.media_id,
                "attempt": capture.attempt_id,
                "author": capture.source.posts[ordered[0]].author.id,
                "root": owners[root] if root else None,
                "published_at": capture.published_at,
                "coverage": json.dumps(
                    {
                        "search_exhausted": (
                            None
                            if capture.source.enumeration is None
                            else capture.source.enumeration == "exhausted"
                        ),
                        "limits": ["post_limit"]
                        if capture.source.enumeration == "post_limit"
                        else [],
                        "unresolved_parent_revision_ids": unresolved,
                        "unchecked_primary_post_media_ids": [],
                    }
                ),
            },
        )
        for index, p in enumerate(ordered):
            db.execute(
                sa.text("""INSERT INTO x_thread_posts (id, thread_media_id, post_media_id, ordinal)
                    VALUES (:id, :thread, :post, :ordinal)"""),
                {
                    "id": new_uuid7(),
                    "thread": capture.media_id,
                    "post": owners[p],
                    "ordinal": index,
                },
            )
        db.execute(
            sa.text("""UPDATE media SET canonical_url=NULL, provider_id=NULL,
                canonical_source_url=:url WHERE id=:id"""),
            {"url": _url(capture.source.requested_post_id), "id": capture.media_id},
        )

    replacements: dict[UUID, UUID] = {}
    rebound_embeds: list[dict[str, Any]] = []
    for wrapper in wrappers:
        ids = writes.replace_article_fragments(
            db, media_id=wrapper.media_id, fragments=wrapper.prepared
        )
        replacements.update(zip(wrapper.fragment_ids, ids, strict=True))
        fragments[f"web:{wrapper.media_id}"] = [
            (identity, prepared.canonical_text)
            for identity, (prepared, _) in zip(ids, wrapper.prepared, strict=True)
        ]
        for embed in wrapper.embeds:
            new_fragment_id = replacements.get(embed["fragment_id"])
            _json_update(
                db,
                "document_embeds",
                embed["id"],
                fragment_id=new_fragment_id,
                canonical_start_offset=embed.get("new_start"),
                canonical_end_offset=embed.get("new_end"),
            )
            if embed["provider"] != "x":
                continue
            _json_update(
                db,
                "document_embeds",
                embed["id"],
                provider_target_ref=embed["provider_target_ref"],
                source_url=embed["source_url"],
                canonical_source_url=embed["canonical_source_url"],
                title="X post",
                description=None,
                thumbnail_url=None,
                authored_text=None,
                placeholder_text="",
            )
            rebound_embeds.append(
                {
                    **embed,
                    "new_fragment_id": new_fragment_id,
                    "new_end": embed.get("new_end"),
                }
            )

    # Rebind immutable evidence while every old source coordinate is still retained
    # in the preflight inventory. Index retraction only follows these writes.
    _rebind_saved(
        db,
        scope=scope,
        bodies=bodies,
        owners=owners,
        fragments=fragments,
        derived=derived,
    )
    for capture in captures:
        if capture.source.source_kind == "author_thread":
            writes.delete_document_embed_artifacts(
                db, owner_user_id=capture.viewer_id, media_id=capture.media_id
            )
            writes.replace_article_fragments(
                db, media_id=capture.media_id, fragments=[]
            )
    for revision, (media_id, attempt_id, post) in sources.items():
        old_post, capture = latest[revision]
        writes.replace_x_post_references(
            db,
            media_id=media_id,
            source_attempt_id=attempt_id,
            post=post,
            aliases={r: owners[r] for r in latest},
            unavailable={
                r.post_id
                for r in old_post.references
                if r.availability == "unavailable"
            },
            viewer_id=capture.viewer_id,
        )
    writes.resolve_x_document_embed_aliases(db, aliases={r: owners[r] for r in latest})
    # Unanchored source-only references keep no invented slot, but their retention
    # owner is still the proved canonical post. Reproject their existing audience.
    for row in rebound_embeds:
        if row["new_end"] is None and row["new_target_media_id"] is not None:
            _json_update(
                db,
                "document_embeds",
                row["id"],
                target_media_id=row["new_target_media_id"],
                resolution_status="resolved",
                error_code=None,
                error_message=None,
            )
    for wrapper in wrappers:
        viewers = set(
            db.scalars(
                sa.text(
                    "SELECT DISTINCT user_id FROM resource_edges WHERE origin='document_embed' AND source_scheme='media' AND source_id=:id"
                ),
                {"id": wrapper.media_id},
            )
        )
        owner = db.scalar(
            sa.text("SELECT created_by_user_id FROM media WHERE id=:id"),
            {"id": wrapper.media_id},
        )
        if owner is not None:
            viewers.add(owner)
        for viewer in viewers:
            writes.reconcile_document_embed_edges_for_viewer(
                db, viewer_id=viewer, media_id=wrapper.media_id
            )
        for target in {
            e["new_target_media_id"]
            for e in wrapper.embeds
            if e["provider"] == "x" and e["new_target_media_id"] is not None
        }:
            writes.sync_document_embed_targets_for_media(db, target_media_id=target)
    _remap_cursors(
        db,
        scope=scope,
        bodies=bodies,
        owners=owners,
        fragments=fragments,
        embeds=rebound_embeds,
        replacements=replacements,
    )
    for media_id in sorted(changed):
        writes.retract_media_content_index(db, media_id=media_id)
        writes.delete_media_unit(db, media_id=media_id)
        writes.request_media_content_reindex(db, media_id=media_id)
    writes.advance_reader_publications(db, media_ids=sorted(changed))
    return len(wrappers), len(changed)


def downgrade() -> None:
    raise NotImplementedError(
        "0293 is irreversible; restore the verified pre-release backup"
    )
