from typing import cast
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.errors import InvalidRequestError
from nexus.schemas.user import DISPLAY_NAME_MAX_LENGTH
from nexus.services.users import update_display_name

pytestmark = pytest.mark.unit


def test_update_display_name_rejects_blank_values():
    with pytest.raises(InvalidRequestError, match="Display name cannot be empty"):
        update_display_name(cast(Session, object()), uuid4(), "   ")


def test_update_display_name_rejects_values_over_the_shared_limit():
    with pytest.raises(InvalidRequestError, match=str(DISPLAY_NAME_MAX_LENGTH)):
        update_display_name(
            cast(Session, object()),
            uuid4(),
            "A" * (DISPLAY_NAME_MAX_LENGTH + 1),
        )
