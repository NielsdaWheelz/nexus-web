from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.podcast import (
    PodcastEpisodeSelection,
    PodcastSourceFacts,
    PodcastSubscribeRequest,
)

pytestmark = pytest.mark.unit


def _podcast_source_facts_payload() -> dict[str, object]:
    return {
        "provider_podcast_id": "podcast-1",
        "title": "Podcast",
        "feed_url": "https://example.com/feed.xml",
        "contributors": [
            {
                "credited_name": "Host",
                "role": "host",
            }
        ],
    }


def _subscribe_payload() -> dict[str, object]:
    return {
        "target": {
            "kind": "Canonical",
            "podcastId": str(uuid4()),
        },
        "namedLibraryIds": [],
        "replacementConfirmation": {"kind": "Absent"},
    }


def test_podcast_source_facts_parse_typed_contributor_payload():
    request = PodcastSourceFacts(**_podcast_source_facts_payload())

    assert request.contributors[0].credited_name == "Host"
    assert request.contributors[0].role == "host"
    assert request.contributors[0].raw_role is None


def test_podcast_write_request_forbids_unknown_top_level_field():
    payload = _subscribe_payload()
    payload["unexpected"] = True

    with pytest.raises(ValidationError):
        PodcastSubscribeRequest(**payload)


def test_podcast_source_facts_forbid_unknown_contributor_field():
    # A stale output-shaped credit (contributorHandle) or a dropped server fact
    # (source/ordinal) is now an unknown field on the strict input model (D-4).
    payload = _podcast_source_facts_payload()
    payload["contributors"] = [
        {
            "credited_name": "Host",
            "role": "host",
            "contributorHandle": "stale-output-field",
        }
    ]

    with pytest.raises(ValidationError):
        PodcastSourceFacts(**payload)


def test_podcast_source_facts_reject_unknown_role():
    payload = _podcast_source_facts_payload()
    payload["contributors"] = [{"credited_name": "Host", "role": "not-a-real-role"}]

    with pytest.raises(ValidationError):
        PodcastSourceFacts(**payload)


def test_podcast_episode_selection_is_state_only():
    selection = PodcastEpisodeSelection.model_validate({"state": "in_progress"})

    assert selection.model_dump() == {"state": "in_progress"}

    with pytest.raises(ValidationError):
        PodcastEpisodeSelection.model_validate(
            {
                "state": "in_progress",
                "query": {"kind": "Present", "value": "episode"},
            }
        )
