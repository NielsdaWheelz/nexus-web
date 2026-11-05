"""The existing account stream's authored head and independent remote-evidence token."""

from pydantic import BaseModel, ConfigDict


class WritingState(BaseModel):
    """``revision`` is the account's ``authored_heads.head_seq``; ``evidence_revision`` changes
    whenever a readable source's ``evidence`` lane changes. Source citations and
    shared highlights refresh independently of authored writing. Decimal counters."""

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    revision: str
    evidence_revision: str
