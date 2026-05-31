import pytest
from pydantic import ValidationError

from nexus.schemas.highlights import CreateHighlightRequest, FragmentAnchorUpdateRequest

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("request_type", "payload"),
    [
        (
            CreateHighlightRequest,
            {"start_offset": 3, "end_offset": 3, "color": "yellow"},
        ),
        (
            FragmentAnchorUpdateRequest,
            {
                "type": "fragment_offsets",
                "start_offset": 3,
                "end_offset": 2,
            },
        ),
    ],
)
def test_fragment_highlight_requests_reject_empty_or_reversed_ranges(
    request_type,
    payload,
):
    with pytest.raises(ValidationError, match="end_offset must be greater"):
        request_type(**payload)


def test_fragment_highlight_requests_accept_forward_ranges():
    create = CreateHighlightRequest(start_offset=3, end_offset=4, color="yellow")
    update = FragmentAnchorUpdateRequest(
        type="fragment_offsets",
        start_offset=3,
        end_offset=4,
    )

    assert create.end_offset > create.start_offset
    assert update.end_offset > update.start_offset
