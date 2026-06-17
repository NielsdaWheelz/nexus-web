from __future__ import annotations

from uuid import uuid4

import pytest

from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


def test_object_ref_routes_reject_user_graph_tags(auth_client):
    headers = auth_headers(create_test_user_id())

    search = auth_client.get("/object-refs/search?q=sot&type=tag", headers=headers)
    assert search.status_code == 400, search.text
    assert search.json()["error"]["code"] == "E_INVALID_REQUEST"

    resolve = auth_client.get(f"/object-refs/resolve?ref=tag:{uuid4()}", headers=headers)
    assert resolve.status_code == 400, resolve.text
    assert resolve.json()["error"]["code"] == "E_INVALID_REQUEST"
