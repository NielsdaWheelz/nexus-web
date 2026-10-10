"""Bounded-retry JSON GET for trusted first-party provider APIs (no SSRF guard).

Untrusted URLs go through ``net.safe_fetch``. A failure raises ``ApiError(error_code)``
whose ``__cause__`` is the last httpx error, so callers can read the final response.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

import httpx

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_AFTER_CAP_SECONDS = 10.0


def get_json_with_retry(
    url: str,
    *,
    headers: Mapping[str, str],
    params: Mapping[str, Any],
    timeout_s: float,
    backoff_seconds: tuple[float, ...],
    error_code: ApiErrorCode,
    provider_name: str,
    honor_retry_after: bool = False,
) -> dict[str, Any]:
    """GET a JSON object, retrying retryable statuses and transport errors per backoff."""
    with httpx.Client(timeout=timeout_s, trust_env=False) as client:
        for delay in (*backoff_seconds, None):
            try:
                response = client.get(url, headers=dict(headers), params=dict(params))
                if response.status_code in _RETRYABLE_STATUS and delay is not None:
                    logger.warning(
                        "provider_retryable_http_error",
                        provider=provider_name,
                        status_code=response.status_code,
                    )
                    retry_after = response.headers.get("retry-after") if honor_retry_after else None
                    wait = _retry_after(retry_after)
                    time.sleep(delay if wait is None else wait)
                    continue
                response.raise_for_status()
                payload = response.json()
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if delay is None:
                    raise ApiError(error_code, f"{provider_name} request failed") from exc
                logger.warning("provider_retryable_transport_error", provider=provider_name)
                time.sleep(delay)
                continue
            except (httpx.HTTPError, ValueError) as exc:
                raise ApiError(error_code, f"{provider_name} request failed") from exc
            if not isinstance(payload, dict):
                raise ApiError(error_code, f"{provider_name} returned an invalid response")
            return payload
    raise AssertionError("the final attempt always returns or raises")


def _retry_after(value: str | None) -> float | None:
    try:
        return min(float(value), _RETRY_AFTER_CAP_SECONDS) if value else None
    except ValueError:
        return None
