"""Project Gutenberg catalog Browse adapter."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.browse import (
    BrowseCandidate,
    BrowseSource,
    EpubCandidate,
    EpubFacts,
    PreviewResolution,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import absent, present
from nexus.services.browse.cursor import (
    BrowseSearchPlan,
    decode_search_cursor,
    encode_search_cursor,
)
from nexus.services.browse.models import (
    BrowseQuery,
    BrowseTargetNotFound,
    gutenberg_target,
    seal_target,
)
from nexus.services.contributor_credits import visible_credit_rows_sql

_PROVIDER_CONTRACT = "ProjectGutenbergCatalogSearch"
_LANDING = "https://www.gutenberg.org/ebooks/{ebook_ref}"
_IMPORT = "https://www.gutenberg.org/ebooks/{ebook_ref}.epub.noimages"


@dataclass(frozen=True, slots=True)
class GutenbergBook:
    ebook_ref: str
    title: str
    description: str | None
    contributors: list[ContributorCreditOut]
    landing_href: str
    import_href: str


def search(
    db: Session,
    *,
    viewer_id: UUID,
    query: BrowseQuery,
) -> tuple[list[BrowseCandidate], str | None]:
    offset = 0
    if query.cursor is not None:
        offset = int(
            decode_search_cursor(
                query.cursor,
                query,
                viewer_id=viewer_id,
                provider_contract=_PROVIDER_CONTRACT,
                plan=BrowseSearchPlan.ProjectGutenbergRankOffset,
            )
        )
    rows = (
        db.execute(
            text(
                f"""
                WITH credits AS (
                    SELECT
                        vcc.project_gutenberg_catalog_ebook_id AS ebook_id,
                        jsonb_agg(
                            jsonb_build_object(
                                'contributor_handle', c.handle,
                                'contributor_display_name', c.display_name,
                                'href', '/authors/' || c.handle,
                                'credited_name', vcc.credited_name,
                                'role', vcc.role,
                                'raw_role', vcc.raw_role,
                                'ordinal', vcc.ordinal
                            )
                            ORDER BY vcc.ordinal
                        ) AS contributors,
                        string_agg(vcc.credited_name || ' ' || c.display_name, ' ') AS names
                    FROM ({visible_credit_rows_sql()}) vcc
                    JOIN contributors c ON c.id = vcc.contributor_id
                    WHERE vcc.project_gutenberg_catalog_ebook_id IS NOT NULL
                    GROUP BY vcc.project_gutenberg_catalog_ebook_id
                ),
                hits AS (
                    SELECT
                        pg.ebook_id,
                        pg.title,
                        pg.subjects,
                        pg.bookshelves,
                        pg.download_count,
                        credits.contributors,
                        ts_rank_cd(
                            to_tsvector(
                                'english',
                                concat_ws(
                                    ' ',
                                    pg.title,
                                    credits.names,
                                    pg.subjects,
                                    pg.bookshelves
                                )
                            ),
                            websearch_to_tsquery('english', :query)
                        ) AS score
                    FROM project_gutenberg_catalog pg
                    LEFT JOIN credits ON credits.ebook_id = pg.ebook_id
                    WHERE to_tsvector(
                        'english',
                        concat_ws(
                            ' ',
                            pg.title,
                            credits.names,
                            pg.subjects,
                            pg.bookshelves
                        )
                    ) @@ websearch_to_tsquery('english', :query)
                )
                SELECT *
                FROM hits
                ORDER BY score DESC, download_count DESC NULLS LAST, ebook_id ASC
                OFFSET :offset
                LIMIT :limit
                """
            ),
            {
                "viewer_id": viewer_id,
                "query": query.query,
                "offset": offset,
                "limit": query.limit + 1,
            },
        )
        .mappings()
        .all()
    )
    items: list[BrowseCandidate] = [_candidate(_book(row)) for row in rows[: query.limit]]
    next_cursor = None
    if len(rows) > query.limit:
        next_cursor = encode_search_cursor(
            query,
            viewer_id=viewer_id,
            provider_contract=_PROVIDER_CONTRACT,
            plan=BrowseSearchPlan.ProjectGutenbergRankOffset,
            after=offset + query.limit,
        )
    return items, next_cursor


def preview(
    db: Session,
    *,
    viewer_id: UUID,
    ebook_ref: str,
) -> GutenbergBook:
    if not ebook_ref.isascii() or not ebook_ref.isdecimal() or ebook_ref.startswith("0"):
        raise BrowseTargetNotFound
    row = (
        db.execute(
            text(
                f"""
                WITH credits AS (
                    SELECT
                        jsonb_agg(
                            jsonb_build_object(
                                'contributor_handle', c.handle,
                                'contributor_display_name', c.display_name,
                                'href', '/authors/' || c.handle,
                                'credited_name', vcc.credited_name,
                                'role', vcc.role,
                                'raw_role', vcc.raw_role,
                                'ordinal', vcc.ordinal
                            )
                            ORDER BY vcc.ordinal
                        ) AS contributors
                    FROM ({visible_credit_rows_sql()}) vcc
                    JOIN contributors c ON c.id = vcc.contributor_id
                    WHERE vcc.project_gutenberg_catalog_ebook_id = :ebook_id
                )
                SELECT
                    pg.ebook_id,
                    pg.title,
                    pg.subjects,
                    pg.bookshelves,
                    credits.contributors
                FROM project_gutenberg_catalog pg
                CROSS JOIN credits
                WHERE pg.ebook_id = :ebook_id
                """
            ),
            {"viewer_id": viewer_id, "ebook_id": int(ebook_ref)},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise BrowseTargetNotFound
    return _book(row)


def _book(row) -> GutenbergBook:
    ebook_ref = str(row["ebook_id"])
    contributors = [
        ContributorCreditOut.model_validate(value) for value in list(row["contributors"] or [])
    ]
    description = row["bookshelves"] or row["subjects"]
    return GutenbergBook(
        ebook_ref=ebook_ref,
        title=str(row["title"] or "Untitled ebook"),
        description=None if description is None else str(description),
        contributors=contributors,
        landing_href=_LANDING.format(ebook_ref=ebook_ref),
        import_href=_IMPORT.format(ebook_ref=ebook_ref),
    )


def _candidate(book: GutenbergBook) -> EpubCandidate:
    target = seal_target(gutenberg_target(book.ebook_ref))
    return EpubCandidate(
        source=BrowseSource.ProjectGutenberg,
        resolution=PreviewResolution(target=target),
        title=book.title,
        contributors=book.contributors,
        description=absent() if book.description is None else present(book.description),
        published_at=absent(),
        image=absent(),
        kind_facts=EpubFacts(ebook_ref=present(book.ebook_ref)),
    )
