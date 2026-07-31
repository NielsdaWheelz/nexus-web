import pytest
from pydantic import ValidationError

from nexus.schemas.user import DISPLAY_NAME_MAX_LENGTH, UpdateProfileRequest

pytestmark = pytest.mark.unit


def test_update_profile_request_rejects_values_over_the_shared_display_limit():
    with pytest.raises(ValidationError):
        UpdateProfileRequest(
            display_name="A" * (DISPLAY_NAME_MAX_LENGTH + 1),
        )


@pytest.mark.parametrize("value", [None, "Not/A_Zone"])
def test_update_profile_request_rejects_non_iana_calendar_timezone(value):
    with pytest.raises(ValidationError):
        UpdateProfileRequest(calendar_time_zone=value)
