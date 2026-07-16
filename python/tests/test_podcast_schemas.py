import pytest
from pydantic import ValidationError

from nexus.schemas.podcast import PodcastEnsureRequest, PodcastSubscribeRequest

pytestmark = pytest.mark.unit


def _podcast_payload() -> dict[str, object]:
    # Credits ride the snake-strict ContributorCreditIn v2 (D-4); the scaffold
    # normalizer still strips stale output-shaped fields until S4 deletes it.
    return {
        "provider_podcast_id": "podcast-1",
        "title": "Podcast",
        "feed_url": "https://example.com/feed.xml",
        "contributors": [
            {
                "credited_name": "Host",
                "role": "host",
                "contributorHandle": "stale-output-field",
            }
        ],
    }


@pytest.mark.parametrize("request_type", [PodcastEnsureRequest, PodcastSubscribeRequest])
def test_podcast_write_requests_normalize_contributor_payloads(request_type):
    request = request_type(**_podcast_payload())

    assert request.contributors[0].credited_name == "Host"
    assert request.contributors[0].role == "host"


@pytest.mark.parametrize("request_type", [PodcastEnsureRequest, PodcastSubscribeRequest])
def test_podcast_write_requests_forbid_unknown_fields(request_type):
    payload = _podcast_payload()
    payload["unexpected"] = True

    with pytest.raises(ValidationError):
        request_type(**payload)
