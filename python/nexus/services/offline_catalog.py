"""A complete personal browsing projection from one read-only repeatable-read snapshot.

Physical memberships, active subscriptions/imports and visible Lectern selections
admit roots. Included shows admit their complete visible episodes, never provider
history or the global corpus. Domain owners supply facts and total-order plans;
Postgres assigns ordinals so local selectors need no database collation replica.
Retries produce a new independent snapshot identity. This read writes nothing.
"""

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import RowMapping, text
from sqlalchemy.orm import Session

from nexus.api.edge import WIRE_REVISION
from nexus.db.models import TranscriptState
from nexus.schemas import offline_catalog as wire
from nexus.schemas.conversation import ConversationListItemOut
from nexus.schemas.notes import NotePageSummaryOut
from nexus.schemas.podcast import PodcastEpisodeCountsOut
from nexus.services import libraries, library_entries, library_listing, media, notes
from nexus.services.chat.conversations import conversation_index_rows_sql
from nexus.services.collection_keyset import UPDATED_TITLE_PLANS, SortKey, order_by_sql
from nexus.services.consumption import lectern, observation
from nexus.services.podcasts import episodes, subscriptions_query


def _ranked(
    db: Session,
    facts: str,
    plans: Mapping[str, Sequence[SortKey]],
    params: Mapping[str, Any],
) -> Sequence[RowMapping]:
    ranks = ", ".join(
        f"row_number() OVER (ORDER BY {order_by_sql(plan, alias='f')}) AS rank_{name}"
        for name, plan in plans.items()
    )
    return (
        db.execute(
            text(f"WITH facts AS MATERIALIZED ({facts}) SELECT f.*, {ranks} FROM facts f"),
            dict(params),
        )
        .mappings()
        .all()
    )


def _order[Order: BaseModel](row: RowMapping, model: type[Order]) -> Order:
    return model.model_validate({name: row[f"rank_{name}"] for name in model.model_fields})


def read_catalog(db: Session, viewer_id: UUID) -> wire.OfflineCatalogOut:
    """Materialize and validate one complete export inside the caller's read snapshot."""
    captured_at = db.execute(text("SELECT statement_timestamp()")).scalar_one()
    params = {"viewer_id": viewer_id, "viewer": viewer_id}
    library_rows = _ranked(
        db,
        f"SELECT * FROM ({libraries.library_index_rows_sql()}) libraries WHERE system_key IS NULL",
        {name or "default": plan for name, plan in libraries.INDEX_PLANS.items()},
        params,
    )
    member_libraries = [
        libraries.LibraryAccess(**{name: row[name] for name in libraries.LibraryAccess.__slots__})
        for row in library_rows
    ]
    default_id = libraries.default_library_id(db, viewer_id)
    empty_view = library_listing.EntryView(None, None, None, None)
    default_order = order_by_sql(
        library_listing.entry_order_plan(empty_view, is_default=True), alias="f"
    )
    named_order = order_by_sql(
        library_listing.entry_order_plan(empty_view, is_default=False), alias="f"
    )
    added_orders = ", ".join(
        f"row_number() OVER (PARTITION BY library_id ORDER BY "
        f"{order_by_sql(library_listing.entry_order_plan(library_listing.EntryView(name, None, None, None), is_default=False), alias='f')}) AS rank_{name}"
        for name in ("added_asc", "added_desc")
    )
    entry_rows = (
        db.execute(
            text(f"""
            WITH facts AS MATERIALIZED ({library_entries.catalog_entry_rows_sql()})
            SELECT f.*,
                CASE WHEN is_default THEN
                    row_number() OVER (PARTITION BY library_id ORDER BY {default_order})
                ELSE row_number() OVER (PARTITION BY library_id ORDER BY {named_order})
                END AS rank_default, {added_orders}
            FROM facts f
        """),
            params,
        )
        .mappings()
        .all()
    )
    selected_ids = set(
        db.scalars(
            text(f"SELECT media_id FROM ({lectern.lectern_rows_sql()}) membership WHERE visible"),
            params,
        )
    )
    root_media_ids = selected_ids | {row["media_id"] for row in entry_rows}
    show_ids = list(
        db.scalars(
            text(f"""
                SELECT podcast_id FROM ({subscriptions_query.catalog_show_ids_sql()}) roots
                UNION
                SELECT podcast_id FROM podcast_episodes WHERE media_id=ANY(:media_ids)
                ORDER BY podcast_id
            """),
            {**params, "media_ids": list(root_media_ids)},
        )
    )
    episode_rows = _ranked(
        db,
        f"SELECT * FROM ({episodes.episode_rows_sql()}) episodes WHERE podcast_id=ANY(:show_ids)",
        {
            "newest": episodes.episode_order_plan("newest"),
            "oldest": episodes.episode_order_plan("oldest"),
            "duration_asc": episodes.episode_order_plan("duration_asc"),
            "duration_desc": episodes.episode_order_plan("duration_desc"),
        },
        {**params, "show_ids": show_ids},
    )
    media_ids = sorted(root_media_ids | {row["media_id"] for row in episode_rows})
    summaries = media.media_summaries(db, viewer_id=viewer_id, media_ids=media_ids)
    consumption = observation.states(db, viewer_id, media_ids)
    media_rows = _ranked(
        db,
        library_listing.entry_fact_rows_sql(
            "SELECT id AS media_id FROM media WHERE id=ANY(:media_ids)",
            creator=True,
            engagement=False,
            remaining=True,
        ),
        {
            name: library_listing.entry_order_plan(
                library_listing.EntryView(name, None, None, None), is_default=False
            )
            for name in wire.MediaOrder.model_fields
        },
        {**params, "media_ids": media_ids},
    )
    unfiled_ids = set(
        db.scalars(
            text(library_entries.unfiled_media_ids_sql()),
            {**params, "library_id": default_id},
        )
    )
    counts = {
        show_id: PodcastEpisodeCountsOut(available_count=0, unfinished_count=0)
        for show_id in show_ids
    }
    for row in episode_rows:
        count = counts[row["podcast_id"]]
        count.available_count += 1
        count.unfinished_count += row["episode_state"] != "played"
    sections, details = subscriptions_query.read_catalog(db, viewer_id, member_libraries, counts)
    followed_rows = _ranked(
        db,
        subscriptions_query.podcast_index_rows_sql(),
        {
            "recent_episode": subscriptions_query.podcast_order_plan("recent_episode"),
            "unplayed_count": subscriptions_query.podcast_order_plan("unplayed_count"),
            "alpha": subscriptions_query.podcast_order_plan("alpha"),
        },
        params,
    )
    followed = {
        row["podcast_id"]: wire.CatalogPodcastIndexOut(
            has_new=row["unplayed_count"] > 0,
            not_in_library=row["not_in_library"],
            order=_order(row, wire.PodcastIndexOrder),
        )
        for row in followed_rows
    }
    updated_plans = {
        "updated_newest": UPDATED_TITLE_PLANS[(None, None)],
        "updated_oldest": UPDATED_TITLE_PLANS[("updated", "asc")],
        "title_asc": UPDATED_TITLE_PLANS[("title", "asc")],
        "title_desc": UPDATED_TITLE_PLANS[("title", "desc")],
    }
    page_rows = _ranked(db, notes.page_index_rows_sql(), updated_plans, params)
    chat_rows = _ranked(db, conversation_index_rows_sql(), updated_plans, params)
    return wire.OfflineCatalogOut(
        format_version=2,
        wire_revision=WIRE_REVISION,
        account_id=viewer_id,
        snapshot_id=uuid4(),
        captured_at=captured_at,
        consumption_revision=observation.revision(db, viewer_id),
        libraries=[
            wire.CatalogLibraryOut(
                value=library.out(viewer_id), order=_order(row, wire.LibraryIndexOrder)
            )
            for library, row in zip(member_libraries, library_rows, strict=True)
        ],
        media=[
            wire.CatalogMediaOut(
                summary=summaries[row["media_id"]],
                is_unfiled=row["media_id"] in unfiled_ids,
                remaining_seconds=row["remaining_seconds"],
                order=_order(row, wire.MediaOrder),
            )
            for row in media_rows
        ],
        library_media=[
            wire.CatalogLibraryMediaOut(
                library_id=row["library_id"],
                media_id=row["media_id"],
                entry_id=row["entry_id"],
                added_at=row["added_at"],
                order=_order(row, wire.LibraryEntryOrder),
            )
            for row in entry_rows
        ],
        shows=[
            wire.CatalogShowOut(detail=details[show_id], index=followed.get(show_id))
            for show_id in show_ids
        ],
        library_shows=[
            wire.CatalogLibraryShowsOut(library_id=library.id, value=sections[library.id])
            for library in member_libraries
        ],
        episodes=[
            wire.CatalogEpisodeOut(
                media_id=row["media_id"],
                podcast_id=row["podcast_id"],
                transcript_state=TranscriptState(row["transcript_state"] or "not_requested"),
                episode_state=row["episode_state"],
                consumption=consumption[row["media_id"]],
                source_duration_ms=row["source_duration_ms"],
                order=_order(row, wire.EpisodeOrder),
            )
            for row in episode_rows
        ],
        lectern=lectern.get_lectern(db, viewer_id, summaries=summaries),
        notes=[
            wire.CatalogNoteOut(
                value=NotePageSummaryOut(
                    id=row["id"], title=row["title"], updated_at=row["updated_at"]
                ),
                order=_order(row, wire.UpdatedTitleOrder),
            )
            for row in page_rows
        ],
        chats=[
            wire.CatalogChatOut(
                value=ConversationListItemOut(
                    id=row["id"],
                    title=row["title"],
                    updated_at=row["updated_at"],
                    message_count=row["message_count"],
                ),
                order=_order(row, wire.UpdatedTitleOrder),
            )
            for row in chat_rows
        ],
    )
