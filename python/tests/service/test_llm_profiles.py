"""Real-FastAPI proof for the fixed product chat-profile contract."""

from fastapi.testclient import TestClient


def test_llm_profiles_route_returns_only_the_three_fixed_presets(
    authenticated_client: TestClient,
) -> None:
    response = authenticated_client.get("/llm-profiles")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "data": {
            "default_profile_id": "balanced",
            "profiles": [
                {
                    "id": "fast",
                    "label": "Fast",
                    "description": "Quick responses for everyday questions.",
                    "model_label": "GPT-5.6 Luna",
                    "effort_label": "Low",
                },
                {
                    "id": "balanced",
                    "label": "Balanced",
                    "description": "The default profile: strong general-purpose reasoning.",
                    "model_label": "GPT-5.6 Terra",
                    "effort_label": "Medium",
                },
                {
                    "id": "deep",
                    "label": "Deep",
                    "description": "Slower, deeper reasoning for hard problems.",
                    "model_label": "GPT-5.6 Sol",
                    "effort_label": "High",
                },
            ],
        }
    }
