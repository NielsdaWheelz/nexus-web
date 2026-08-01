from __future__ import annotations

import asyncio

import httpx
import pytest

from nexus.config import Environment, Settings
from nexus.services.provider_http import provider_request_event_hooks


def _settings(*, environment: Environment, base_url: str) -> Settings:
    return Settings.model_construct(
        nexus_env=environment,
        openai_api_base_url=base_url,
    )


def test_provider_gateway_rewrites_only_the_owned_openai_origin() -> None:
    hooks = provider_request_event_hooks(
        _settings(
            environment=Environment.TEST,
            base_url="http://127.0.0.1:19091/v1",
        )
    )
    rewrite = hooks["request"][0]
    openai = httpx.Request("POST", "https://api.openai.com/v1/responses")
    unrelated = httpx.Request("GET", "https://api.search.brave.com/res/v1/web/search")

    asyncio.run(rewrite(openai))
    asyncio.run(rewrite(unrelated))

    assert str(openai.url) == "http://127.0.0.1:19091/v1/responses"
    assert str(unrelated.url) == "https://api.search.brave.com/res/v1/web/search"


def test_provider_gateway_rejects_plain_http_in_production() -> None:
    with pytest.raises(ValueError, match="must use HTTPS"):
        provider_request_event_hooks(
            _settings(
                environment=Environment.PROD,
                base_url="http://127.0.0.1:19091/v1",
            )
        )
