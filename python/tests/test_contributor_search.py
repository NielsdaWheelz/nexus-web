from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.services import search as search_service
from nexus.services.contributor_credits import replace_media_contributor_credits
from tests.factories import create_test_media_in_library


def _default_library_id(db_session, user_id: UUID) -> UUID:
    return db_session.execute(
        text(
            """
            SELECT id
            FROM libraries
            WHERE owner_user_id = :user_id
              AND is_default = true
            """
        ),
        {"user_id": user_id},
    ).scalar_one()


@pytest.mark.integration
def test_contributor_search_credit_text_is_limited_to_media_scope(
    db_session,
    bootstrapped_user,
):
    user_id = bootstrapped_user
    library_id = _default_library_id(db_session, user_id)
    visible_media_id = create_test_media_in_library(
        db_session,
        user_id,
        library_id,
        title=f"Visible contributor media {uuid4()}",
    )
    hidden_in_scope_media_id = create_test_media_in_library(
        db_session,
        user_id,
        library_id,
        title=f"Other contributor media {uuid4()}",
    )
    external_key = f"orcid-{uuid4()}"

    replace_media_contributor_credits(
        db_session,
        media_id=visible_media_id,
        credits=[
            {
                "name": "Visible Scope Name",
                "role": "author",
                "source": "test_provider",
                "external_id": {
                    "authority": "orcid",
                    "external_key": external_key,
                },
            }
        ],
    )
    replace_media_contributor_credits(
        db_session,
        media_id=hidden_in_scope_media_id,
        credits=[
            {
                "name": "Hidden Scope Name",
                "role": "author",
                "source": "test_provider",
                "external_id": {
                    "authority": "orcid",
                    "external_key": external_key,
                },
            }
        ],
    )

    visible_scope_results = search_service.search(
        db_session,
        user_id,
        q="Hidden Scope",
        scope=f"media:{visible_media_id}",
        types=["contributor"],
    )
    hidden_scope_results = search_service.search(
        db_session,
        user_id,
        q="Hidden Scope",
        scope=f"media:{hidden_in_scope_media_id}",
        types=["contributor"],
    )

    assert visible_scope_results.results == []
    assert [result.type for result in hidden_scope_results.results] == ["contributor"]
