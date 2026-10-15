"""FastAPI dependencies owned by the api layer."""

from typing import Annotated

from fastapi import Header, Request

from nexus.services.generation.catalog import Catalog

DeviceId = Annotated[str, Header(alias="X-Nexus-Device", min_length=1, max_length=200)]
"""The caller's device, named only by the bff from its httpOnly cookie (I7); a request
without it answers 400 ``E_INVALID_REQUEST``."""


def get_generation_catalog(request: Request) -> Catalog:
    """The one process-owned generation catalog."""
    service = getattr(request.app.state, "generation_catalog", None)
    # justify-service-invariant-check: app.state is dynamic; an incomplete composition
    # is one loud operator defect, not Any leaking into handlers.
    if not isinstance(service, Catalog):
        raise RuntimeError("generation catalog is not initialized")
    return service
