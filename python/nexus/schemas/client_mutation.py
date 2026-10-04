"""Canonical text UUIDs for existing resource mutation receipts."""

from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator


def _canonical_uuid_text(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text") from exc
    if str(parsed) != value:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text")
    return value


ClientMutationUuidText = Annotated[str, AfterValidator(_canonical_uuid_text)]
