"""Pure canonical playback-rate resolution policy."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.presence import Absent, Present
from nexus.services.consumption._projection import resolve_playback_rate

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("episode_rate", "subscription_preference", "value", "source"),
    [
        (1.8, Present[float](value=1.5), 1.8, "Episode"),
        (None, Present[float](value=1.5), 1.5, "Podcast"),
        (None, Absent(), 1.0, "Product"),
        (None, None, 1.0, "Product"),
    ],
)
def test_resolves_episode_subscription_and_product_precedence(
    episode_rate,
    subscription_preference,
    value,
    source,
):
    podcast_id = uuid4()

    resolution = resolve_playback_rate(
        episode_rate=episode_rate,
        podcast_id=podcast_id,
        subscription_preference=subscription_preference,
    )

    assert resolution.value == value
    assert resolution.source == source
    if subscription_preference is None:
        assert resolution.podcast_preference.kind == "Absent"
    else:
        assert resolution.podcast_preference.kind == "Present"
        assert resolution.podcast_preference.value.podcast_id == podcast_id
        assert (
            resolution.podcast_preference.value.value.model_dump()
            == subscription_preference.model_dump()
        )


@pytest.mark.parametrize(
    ("episode_rate", "subscription_preference"),
    [
        (0.49, None),
        (3.01, None),
        (None, Present[float](value=0.49)),
        (None, Present[float](value=3.01)),
    ],
)
def test_invalid_trusted_rates_defect(episode_rate, subscription_preference):
    with pytest.raises(ValidationError):
        resolve_playback_rate(
            episode_rate=episode_rate,
            podcast_id=uuid4(),
            subscription_preference=subscription_preference,
        )
