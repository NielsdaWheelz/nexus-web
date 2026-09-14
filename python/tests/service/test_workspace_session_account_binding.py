"""A durable layout cannot replay into whichever account later owns the cookie."""

from uuid import uuid4

from fastapi.testclient import TestClient

from tests.testkit.auth import UserRecord


def test_workspace_replay_rejects_another_account_before_changing_layout(
    authenticated_client: TestClient,
    test_user: UserRecord,
) -> None:
    path = "/me/workspace-session"
    device_id = "bounded-workspace-proof"
    headers = {"X-Nexus-Expected-Account-Id": str(test_user.id)}
    original = {"proof": "original"}
    saved = authenticated_client.put(
        path,
        headers=headers,
        json={
            "device_id": device_id,
            "state": original,
        },
    )
    assert saved.status_code == 200, saved.text
    rejected = authenticated_client.put(
        path,
        headers={
            "X-Nexus-Expected-Account-Id": str(uuid4()),
        },
        json={"device_id": device_id, "state": {"proof": "foreign replay"}},
    )
    assert rejected.status_code == 403, rejected.text
    restored = authenticated_client.get(path, params={"device_id": device_id})
    assert restored.status_code == 200, restored.text
    assert restored.json()["data"]["own"]["state"] == original
