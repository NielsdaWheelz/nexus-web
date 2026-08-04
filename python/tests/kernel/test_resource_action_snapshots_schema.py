"""Kernel proof for the canonical resource-action snapshot wire schema.

Risk: the snapshot resolve endpoint is the single source of per-resource action
FACTS. If the request validator accepts malformed batches, or the capability
union silently coerces an unknown/mis-shaped kind, or ``factsRevision`` is not a
faithful content hash, every downstream planner and menu inherits corrupt facts.

Independent oracle: the authoritative design contract's "Backend wire contract"
section (camelCase discriminated unions; 1..100 unique parseable refs =>
otherwise ``E_INVALID_REQUEST``; ``factsRevision`` = sha256hex of the by-alias
canonical JSON with ``factsRevision`` itself excluded). Behaviour is asserted
through the public model boundary only.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.resource_action_snapshots import (
    ResourceActionSnapshotOut,
    ResourceActionSnapshotResolveRequest,
    ResourceActionSnapshotResolveResponse,
    compute_facts_revision,
)
from nexus.schemas.resource_items import ResourceActivationOut


def _media_ref() -> str:
    return f"media:{uuid4()}"


def _activation(ref: str) -> ResourceActivationOut:
    return ResourceActivationOut(resource_ref=ref, kind="route", href="/media/x")


def _snapshot(ref: str, capabilities: list[dict]) -> ResourceActionSnapshotOut:
    """Build a snapshot from the wire shape the server emits (camelCase)."""
    return ResourceActionSnapshotOut.model_validate(
        {
            "ref": ref,
            "activation": _activation(ref).model_dump(mode="json", by_alias=True),
            "missing": False,
            "factsRevision": "",
            "capabilities": capabilities,
        }
    )


# --------------------------------------------------------------------------
# Request validator: 1..100 unique parseable refs, else E_INVALID_REQUEST (400)
# --------------------------------------------------------------------------


def test_request_accepts_valid_batch_of_unique_parseable_refs() -> None:
    refs = [_media_ref() for _ in range(3)]
    request = ResourceActionSnapshotResolveRequest(refs=refs)
    assert request.refs == refs


def test_request_accepts_maximum_batch_of_one_hundred() -> None:
    refs = [_media_ref() for _ in range(100)]
    assert ResourceActionSnapshotResolveRequest(refs=refs).refs == refs


def test_request_rejects_empty_refs_as_invalid_request() -> None:
    with pytest.raises(InvalidRequestError) as caught:
        ResourceActionSnapshotResolveRequest(refs=[])
    assert caught.value.code is ApiErrorCode.E_INVALID_REQUEST
    assert caught.value.status_code == 400


def test_request_rejects_more_than_one_hundred_refs_as_invalid_request() -> None:
    refs = [_media_ref() for _ in range(101)]
    with pytest.raises(InvalidRequestError) as caught:
        ResourceActionSnapshotResolveRequest(refs=refs)
    assert caught.value.code is ApiErrorCode.E_INVALID_REQUEST


def test_request_rejects_duplicate_refs_as_invalid_request() -> None:
    ref = _media_ref()
    with pytest.raises(InvalidRequestError) as caught:
        ResourceActionSnapshotResolveRequest(refs=[ref, ref])
    assert caught.value.code is ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.parametrize(
    "bad_ref",
    [
        "not-a-ref",  # no scheme separator
        "bogus:00000000-0000-0000-0000-000000000000",  # unsupported scheme
        "media:not-a-uuid",  # unparseable id
    ],
    ids=["no-separator", "unsupported-scheme", "bad-uuid"],
)
def test_request_rejects_unparseable_ref_as_invalid_request(bad_ref: str) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        ResourceActionSnapshotResolveRequest(refs=[_media_ref(), bad_ref])
    assert caught.value.code is ApiErrorCode.E_INVALID_REQUEST


# --------------------------------------------------------------------------
# Capability union: discriminates on 'kind', serializes camelCase, closed set
# --------------------------------------------------------------------------


def test_capability_union_discriminates_every_kind_and_carries_availability() -> None:
    ref = _media_ref()
    capabilities = [
        {"kind": "Open", "availability": {"kind": "Available"}},
        {"kind": "Share", "availability": {"kind": "Available"}},
        {"kind": "Chat", "availability": {"kind": "Blocked", "reason": "Locked"}},
        {"kind": "OpenSource", "availability": {"kind": "Available"}, "href": "https://src"},
        {"kind": "RetryProcessing", "availability": {"kind": "Blocked", "reason": "Processing"}},
        {"kind": "RefreshSource", "availability": {"kind": "Available"}},
        {"kind": "RetryMetadata", "availability": {"kind": "Available"}},
        {"kind": "EditAuthors", "availability": {"kind": "Available"}},
        {"kind": "ResetProgress", "availability": {"kind": "Available"}},
        {"kind": "LibrarySettings", "availability": {"kind": "Available"}},
        {"kind": "DeleteLibrary", "availability": {"kind": "Available"}},
        {"kind": "PodcastSettings", "availability": {"kind": "Available"}},
        {"kind": "RefreshPodcast", "availability": {"kind": "Available"}},
        {"kind": "DeleteConversation", "availability": {"kind": "Available"}},
        {"kind": "RemoveMedia", "availability": {"kind": "Available"}},
        {"kind": "LibraryPlacement", "availability": {"kind": "Available"}},
        {
            "kind": "OfflineAudio",
            "availability": {"kind": "Blocked", "reason": "TemporarilyUnavailable"},
        },
        {"kind": "Consumption", "availability": {"kind": "Available"}, "state": "InProgress"},
        {"kind": "EpisodeConsumption", "availability": {"kind": "Available"}, "state": "Played"},
        {
            "kind": "PodcastSubscription",
            "availability": {"kind": "Available"},
            "state": "Subscribed",
        },
        {
            "kind": "LecternMembership",
            "availability": {"kind": "Available"},
            "state": "Present",
            "lecternItemId": "item-1",
        },
    ]
    snapshot = _snapshot(ref, capabilities)

    dumped = snapshot.model_dump(mode="json", by_alias=True)
    dumped_caps = dumped["capabilities"]

    # every capability round-tripped, in order, with its discriminated shape
    assert [cap["kind"] for cap in dumped_caps] == [cap["kind"] for cap in capabilities]

    by_kind = {cap["kind"]: cap for cap in dumped_caps}
    assert by_kind["Chat"]["availability"] == {"kind": "Blocked", "reason": "Locked"}
    assert by_kind["OpenSource"]["href"] == "https://src"
    assert by_kind["Consumption"]["state"] == "InProgress"
    assert by_kind["EpisodeConsumption"]["state"] == "Played"
    assert by_kind["PodcastSubscription"]["state"] == "Subscribed"
    # camelCase alias on the wire, present state carries the lectern item id
    assert by_kind["LecternMembership"]["lecternItemId"] == "item-1"
    assert by_kind["LecternMembership"]["state"] == "Present"


def test_lectern_membership_absent_has_no_item_id() -> None:
    ref = _media_ref()
    snapshot = _snapshot(
        ref,
        [
            {
                "kind": "LecternMembership",
                "availability": {"kind": "Available"},
                "state": "Absent",
            }
        ],
    )
    dumped = snapshot.model_dump(mode="json", by_alias=True)
    cap = dumped["capabilities"][0]
    assert cap["state"] == "Absent"
    assert cap.get("lecternItemId") is None


def test_capability_union_rejects_unknown_kind_at_the_boundary() -> None:
    ref = _media_ref()
    with pytest.raises(ValueError):
        _snapshot(ref, [{"kind": "NotAKind", "availability": {"kind": "Available"}}])


def test_availability_blocked_rejects_client_only_reason() -> None:
    # Client-only reasons (RequiresOnline/DeviceUnsupported/Busy) are forbidden
    # from this API; the server availability union must not admit them.
    ref = _media_ref()
    with pytest.raises(ValueError):
        _snapshot(
            ref,
            [{"kind": "Open", "availability": {"kind": "Blocked", "reason": "RequiresOnline"}}],
        )


# --------------------------------------------------------------------------
# factsRevision: sha256hex of by-alias canonical JSON, factsRevision excluded
# --------------------------------------------------------------------------


def test_facts_revision_is_deterministic_across_reserialization() -> None:
    ref = _media_ref()
    caps = [{"kind": "Open", "availability": {"kind": "Available"}}]
    original = _snapshot(ref, caps)

    revision = compute_facts_revision(original)
    assert len(revision) == 64  # sha256 hex digest
    assert all(char in "0123456789abcdef" for char in revision)

    # rebuilding the identical snapshot from its own by-alias dump is stable
    rebuilt = ResourceActionSnapshotOut.model_validate(
        original.model_dump(mode="json", by_alias=True)
    )
    assert compute_facts_revision(rebuilt) == revision


def test_facts_revision_changes_when_a_capability_changes() -> None:
    ref = _media_ref()
    available = _snapshot(ref, [{"kind": "Open", "availability": {"kind": "Available"}}])
    blocked = _snapshot(
        ref,
        [{"kind": "Open", "availability": {"kind": "Blocked", "reason": "Processing"}}],
    )
    assert compute_facts_revision(available) != compute_facts_revision(blocked)


def test_facts_revision_excludes_its_own_field() -> None:
    ref = _media_ref()
    caps = [{"kind": "Open", "availability": {"kind": "Available"}}]
    base = _snapshot(ref, caps)
    with_placeholder = base.model_copy(update={"facts_revision": "already-populated"})
    # The revision hashes {ref,activation,missing,capabilities} only; the stored
    # factsRevision value must not feed back into the hash.
    assert compute_facts_revision(base) == compute_facts_revision(with_placeholder)
