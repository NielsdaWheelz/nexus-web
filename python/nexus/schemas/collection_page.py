"""The response envelope for genuinely paged collections."""

from pydantic import BaseModel, ConfigDict


class CollectionPage[T](BaseModel):
    """One page in list order; ``next_cursor`` is null exactly at the end."""

    items: list[T]
    next_cursor: str | None

    model_config = ConfigDict(extra="forbid")
