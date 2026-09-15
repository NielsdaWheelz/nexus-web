"""Collection revision publication for shared Media facts."""

from sqlalchemy import text
from sqlalchemy.orm import Session


def bump_all_media_fact_collections(db: Session) -> None:
    """Advance every viewer collection whose rows project shared Media facts."""
    db.execute(
        text(
            """
            INSERT INTO viewer_collection_revisions (viewer_id, family, revision)
            SELECT users.id, families.family, 1
            FROM users
            CROSS JOIN (
                VALUES ('AuthorWorks'), ('LibraryEntries'), ('PodcastEpisodes')
            ) AS families(family)
            ON CONFLICT (viewer_id, family)
            DO UPDATE SET revision = viewer_collection_revisions.revision + 1
            """
        )
    )
