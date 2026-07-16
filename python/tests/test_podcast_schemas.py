import pytest
from pydantic import ValidationError

from nexus.schemas.podcast import PodcastSubscribeRequest

pytestmark = pytest.mark.unit


def _podcast_payload() -> dict[str, object]:
    # Credits ride the snake-strict ContributorCreditIn v2 (D-4): credited_name,
    # role, raw_role only. The former output-field scrub is gone (S4).
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


def test_podcast_write_request_parses_typed_contributor_payload():
    request = PodcastSubscribeRequest(**_podcast_payload())

    assert request.contributors[0].credited_name == "Host"
    assert request.contributors[0].role == "host"
    assert request.contributors[0].raw_role is None


def test_podcast_write_request_forbids_unknown_top_level_field():
    payload = _podcast_payload()
    payload["unexpected"] = True

    with pytest.raises(ValidationError):
        PodcastSubscribeRequest(**payload)


def test_podcast_write_request_forbids_unknown_contributor_field():
    # A stale output-shaped credit (contributorHandle) or a dropped server fact
    # (source/ordinal) is now an unknown field on the strict input model (D-4).
    payload = _podcast_payload()
    payload["contributors"] = [
        {
            "credited_name": "Host",
            "role": "host",
            "contributorHandle": "stale-output-field",
        }
    ]

    with pytest.raises(ValidationError):
        PodcastSubscribeRequest(**payload)


def test_podcast_write_request_rejects_unknown_role():
    payload = _podcast_payload()
    payload["contributors"] = [{"credited_name": "Host", "role": "not-a-real-role"}]

    with pytest.raises(ValidationError):
        PodcastSubscribeRequest(**payload)
