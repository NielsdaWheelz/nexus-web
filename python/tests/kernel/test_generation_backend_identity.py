"""Canonical route identity at the backend-to-ledger ownership boundary."""

from __future__ import annotations

import json
from importlib.util import find_spec
from types import MappingProxyType
from typing import TYPE_CHECKING
from uuid import UUID

import pytest

_CUTOVER_PRESENT = find_spec("nexus.services.generation_backend") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.services.generation_backend import BackendChildDispatch


def _require_cutover() -> None:
    assert _CUTOVER_PRESENT, "the route-neutral generation backend is absent"


def test_backend_child_detaches_nested_provider_identity_into_plain_json() -> None:
    """Risk: provider-runtime MappingProxy children cannot enter the durable ledger."""

    _require_cutover()
    nested = {"continuation_fingerprint": MappingProxyType({"kind": "Absent"})}
    child = BackendChildDispatch(
        generation_id=UUID(int=1),
        child_seq=1,
        route="ProviderApi",
        request_fingerprint="a" * 64,
        route_request_identity=MappingProxyType(nested),
    )

    assert json.loads(json.dumps(dict(child.route_request_identity))) == {
        "continuation_fingerprint": {"kind": "Absent"}
    }
    nested["continuation_fingerprint"] = MappingProxyType({"kind": "Present"})
    assert child.route_request_identity["continuation_fingerprint"] == {"kind": "Absent"}


@pytest.mark.parametrize("unsafe", ({"value": float("nan")}, {"value": object()}))
def test_backend_child_refuses_noncanonical_route_identity(unsafe: dict[str, object]) -> None:
    _require_cutover()
    with pytest.raises(ValueError, match="canonical JSON"):
        BackendChildDispatch(
            generation_id=UUID(int=1),
            child_seq=1,
            route="ProviderApi",
            request_fingerprint="a" * 64,
            route_request_identity=unsafe,
        )
