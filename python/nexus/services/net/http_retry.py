"""Bounded-retry JSON GET for trusted first-party provider APIs (no SSRF guard).

Untrusted URLs go through ``net.safe_fetch``. A failure raises ``ApiError(error_code)``
whose ``__cause__`` is the last httpx error, so callers can read the final response.
"""

from __future__ import annotations

import math
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
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
                if response.status_code in RETRYABLE_STATUSES and delay is not None:
                    logger.warning(
                        "provider_retryable_http_error",
                        provider=provider_name,
                        status_code=response.status_code,
                    )
                    retry_after = response.headers.get("retry-after") if honor_retry_after else None
                    when = retry_at(retry_after)
                    wait = (
                        delay
                        if when is None
                        else min(
                            max((when - datetime.now(UTC)).total_seconds(), 0.0),
                            _RETRY_AFTER_CAP_SECONDS,
                        )
                    )
                    time.sleep(wait)
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
                when = (
                    retry_at(exc.response.headers.get("retry-after"))
                    if honor_retry_after and isinstance(exc, httpx.HTTPStatusError)
                    else None
                )
                raise ApiError(
                    error_code, f"{provider_name} request failed", retry_at=when
                ) from exc
            if not isinstance(payload, dict):
                raise ApiError(error_code, f"{provider_name} returned an invalid response")
            return payload
    raise AssertionError("the final attempt always returns or raises")


def retry_at(value: float | str | None) -> datetime | None:
    """A provider's Retry-After delta or HTTP date as an absolute UTC instant."""
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(str(value))
        except (ValueError, TypeError, OverflowError):
            return None
        return parsed.astimezone(UTC) if parsed.utcoffset() is not None else None
    if not math.isfinite(seconds):
        return None
    try:
        return datetime.now(UTC) + timedelta(seconds=max(seconds, 0.0))
    except OverflowError:
        return None
