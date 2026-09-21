"""Collection revision publication for shared Media facts."""

from sqlalchemy.orm import Session

from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families

_MEDIA_FACT_FAMILIES = (
    CollectionFamily.AuthorWorks,
    CollectionFamily.LibraryEntries,
    CollectionFamily.PodcastEpisodes,
)


def bump_all_media_fact_collections(db: Session) -> None:
    """Advance every viewer collection whose rows project shared Media facts."""
    bump_all_collection_families(db, families=_MEDIA_FACT_FAMILIES)
