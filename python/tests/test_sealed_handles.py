import hashlib
from uuid import uuid4

import pytest

from nexus.services.artifacts.handles import (
    InvalidArtifactBuildHandle,
    seal_artifact_build,
    unseal_artifact_build,
)
from nexus.services.sealed_handles import (
    InvalidSealedHandle,
    InvalidShareToken,
    new_share_token,
    parse_share_token,
    seal_library_invitation,
    seal_resource_grant,
    seal_user,
    share_token_hash,
    unseal_library_invitation,
    unseal_resource_grant,
    unseal_user,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("seal", "unseal"),
    [
        (seal_resource_grant, unseal_resource_grant),
        (seal_user, unseal_user),
        (seal_library_invitation, unseal_library_invitation),
    ],
)
def test_entity_handle_round_trip_and_tamper_rejection(seal, unseal) -> None:
    entity_id = uuid4()
    handle = seal(entity_id)
    assert unseal(handle) == entity_id

    replacement = "A" if handle[-1] != "A" else "B"
    with pytest.raises(InvalidSealedHandle):
        unseal(f"{handle[:-1]}{replacement}")


def test_entity_handle_domains_and_legacy_artifact_handle_do_not_cross_verify() -> None:
    entity_id = uuid4()
    domains = [
        (seal_resource_grant(entity_id), unseal_resource_grant, InvalidSealedHandle),
        (seal_user(entity_id), unseal_user, InvalidSealedHandle),
        (seal_library_invitation(entity_id), unseal_library_invitation, InvalidSealedHandle),
        (seal_artifact_build(entity_id), unseal_artifact_build, InvalidArtifactBuildHandle),
    ]

    for source_index, (handle, _source_unseal, _source_error) in enumerate(domains):
        for target_index, (_target_handle, target_unseal, target_error) in enumerate(domains):
            if source_index == target_index:
                continue
            with pytest.raises(target_error):
                target_unseal(handle)


@pytest.mark.parametrize(
    ("seal", "unseal"),
    [
        (seal_resource_grant, unseal_resource_grant),
        (seal_user, unseal_user),
        (seal_library_invitation, unseal_library_invitation),
    ],
)
def test_entity_handle_parser_rejects_malformed_wire_values(seal, unseal) -> None:
    handle = seal(uuid4())
    prefix, entity_part, tag_part = handle.split(".")
    malformed = [
        "",
        f"{prefix}.{entity_part}",
        f"{prefix}.{entity_part}.",
        f"{prefix}.{entity_part}.{tag_part[:-1]}",
        f"{prefix}.{entity_part}.{tag_part}=",
        f"{prefix[:-1]}2.{entity_part}.{tag_part}",
    ]

    for raw in malformed:
        with pytest.raises(InvalidSealedHandle):
            unseal(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "nxshr1_",
        "nxshr2_" + "A" * 43,
        "nxshr1_" + "A" * 42,
        "nxshr1_" + "A" * 44,
        "nxshr1_" + "+" * 43,
        "nxshr1_" + "A" * 42 + "=",
    ],
)
def test_share_token_parser_rejects_noncanonical_wire_values(raw: str) -> None:
    with pytest.raises(InvalidShareToken):
        parse_share_token(raw)


def test_share_token_round_trip_and_domain_separated_verifier() -> None:
    token = new_share_token()
    assert parse_share_token(token) == token
    assert len(share_token_hash(token)) == 32
    assert share_token_hash(token) != hashlib.sha256(token.encode("ascii")).digest()
