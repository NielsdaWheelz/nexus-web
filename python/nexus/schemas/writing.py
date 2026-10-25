"""The writing stream's wake state: the account's authored feed head and annotation audience."""

from pydantic import BaseModel, ConfigDict


class WritingState(BaseModel):
    """``revision`` is the account's ``authored_heads.head_seq``; ``annotations_revision`` changes
    whenever any of the viewer's media ``annotations`` lanes is bumped (a peer's or grant's
    highlight change), so a mounted reader refetches its document map. Decimal counters."""

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    revision: str
    annotations_revision: str
