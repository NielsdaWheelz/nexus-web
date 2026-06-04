"""Retry-with-backoff JSON GET for TRUSTED first-party provider APIs.

`trust_env=False`, optional `Retry-After` honoring, bounded retries on a fixed
retryable-status set. There is deliberately NO SSRF guard here: these are our own
provider endpoints (Podcast Index now; browse is a noted follow-up), not
feed-controlled URLs. Feed-controlled URLs use `net/safe_fetch.py` instead.
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
    """GET JSON from a trusted first-party API, retrying transient errors.

    Retries on `_RETRYABLE_STATUS` and transport errors up to `len(backoff_seconds)`
    times. Raises `ApiError(error_code)` on exhaustion or a non-object payload.
    """
    attempts = len(backoff_seconds) + 1
    last_exc: Exception | None = None
    with httpx.Client(timeout=timeout_s, trust_env=False) as client:
        for attempt_index in range(attempts):
            try:
                response = client.get(url, headers=dict(headers), params=dict(params))
                if response.status_code in _RETRYABLE_STATUS and attempt_index < attempts - 1:
                    logger.warning(
                        "provider_retryable_http_error",
                        provider=provider_name,
                        status_code=response.status_code,
                        attempt=attempt_index + 1,
                    )
                    time.sleep(
                        _retry_delay(attempt_index, backoff_seconds, response, honor_retry_after)
                    )
                    continue
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ApiError(error_code, f"{provider_name} returned an invalid response")
                return payload
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_exc = exc
                if attempt_index < attempts - 1:
                    logger.warning(
                        "provider_retryable_transport_error",
                        provider=provider_name,
                        attempt=attempt_index + 1,
                        error=str(exc),
                    )
                    time.sleep(backoff_seconds[attempt_index])
                    continue
                break
            except (httpx.HTTPError, ValueError) as exc:
                last_exc = exc
                break
    raise ApiError(error_code, f"{provider_name} request failed") from last_exc


def _retry_delay(
    attempt_index: int,
    backoff_seconds: tuple[float, ...],
    response: httpx.Response,
    honor_retry_after: bool,
) -> float:
    if honor_retry_after:
        raw = response.headers.get("retry-after")
        if raw:
            try:
                return min(float(raw), _RETRY_AFTER_CAP_SECONDS)
            except ValueError:
                pass
    return backoff_seconds[attempt_index]
