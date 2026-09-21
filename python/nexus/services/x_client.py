"""Official X API client for public post/thread snapshots."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from time import perf_counter, sleep
from typing import Any

import httpx
from pydantic import TypeAdapter, ValidationError

from nexus.config import get_settings
from nexus.logging import get_logger
from nexus.services.x_identity import normalize_x_username
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XMediaSnapshot,
    XPostSnapshot,
    XProviderError,
    XProviderErrorCode,
    XQuoteReference,
    XResolvedQuoteReference,
    XSinglePostSnapshot,
    XUnavailableQuoteReference,
    XUserSnapshot,
    canonical_x_post_url,
)

logger = get_logger(__name__)

_LOOKUP_PARAMS = {
    "tweet.fields": (
        "id,text,author_id,created_at,conversation_id,referenced_tweets,"
        "in_reply_to_user_id,attachments,entities,note_tweet,lang,possibly_sensitive"
    ),
    "expansions": "referenced_tweets.id,attachments.media_keys,author_id,referenced_tweets.id.author_id",
    "media.fields": "media_key,type,url,preview_image_url,alt_text,width,height",
    "user.fields": "id,name,username",
}
_SEARCH_PAGE_SIZE = 100
_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_BACKOFF_SECONDS = (0.05, 0.1)
_POST_LOOKUP_OPERATIONS = frozenset({"lookup_post", "lookup_x_post"})
_UNAVAILABLE_ERROR_SUFFIXES = ("/resource-not-found", "/not-authorized-for-resource")

_POSTS = TypeAdapter(XPostSnapshot)
_USERS = TypeAdapter(XUserSnapshot)
_MEDIA = TypeAdapter(XMediaSnapshot)


class _Snapshots:
    """Every post, user and media item seen across one operation's payloads."""

    def __init__(self) -> None:
        self.posts: dict[str, XPostSnapshot] = {}
        self.users: dict[str, XUserSnapshot] = {}
        self.media: dict[str, XMediaSnapshot] = {}

    def absorb(self, payload: Mapping[str, Any]) -> list[XPostSnapshot]:
        data = _decode(_POSTS, payload.get("data"))
        raw_includes = payload.get("includes")
        includes: dict[str, Any] = raw_includes if isinstance(raw_includes, dict) else {}
        for post in (*data, *_decode(_POSTS, includes.get("tweets"))):
            existing = self.posts.get(post.id)
            self.posts[post.id] = post if existing is None else _merge_posts(existing, post)
        for user in _decode(_USERS, includes.get("users")):
            handle = normalize_x_username(user.username)
            if handle is not None:
                self.users[user.id] = user.model_copy(
                    update={"name": user.name or handle, "username": handle}
                )
        for item in _decode(_MEDIA, includes.get("media")):
            self.media[item.media_key] = item
        return data


def fetch_author_thread_snapshot(post_id: str) -> XAuthorThreadSnapshot:
    """Look the post up, page the author's conversation, and resolve its quotes."""
    settings = get_settings()
    max_posts = int(settings.x_api_author_thread_max_posts)
    base_url, headers, deadline = _request_config("lookup_post")
    snapshots = _Snapshots()
    unavailable_quote_ids: set[str] = set()

    with httpx.Client(trust_env=False, headers=headers) as client:
        get = _json_getter(client, deadline)
        snapshots.absorb(get(f"{base_url}/tweets/{post_id}", _LOOKUP_PARAMS, "lookup_post"))
        root = snapshots.posts.get(post_id)
        if root is None:
            raise _unavailable("X API returned no post data.", "lookup_post")
        author = snapshots.users.get(root.author_id)
        if author is None:
            raise _unavailable("X API returned no author data.", "lookup_post")

        conversation_id = root.conversation_id or root.id
        candidate_ids = {root.id}
        next_token: str | None = None
        while len(candidate_ids) < max_posts:
            params = {
                **_LOOKUP_PARAMS,
                "query": f"conversation_id:{conversation_id} from:{author.username}",
                "max_results": str(max(10, min(_SEARCH_PAGE_SIZE, max_posts - len(candidate_ids)))),
            }
            if next_token:
                params["next_token"] = next_token
            page = get(f"{base_url}/tweets/search/all", params, "search_author_thread")
            candidate_ids.update(post.id for post in snapshots.absorb(page))
            meta = page.get("meta")
            next_token = meta.get("next_token") if isinstance(meta, dict) else None
            if not next_token:
                break

        thread_posts = _select_thread_posts(
            snapshots.posts, root=root, candidate_ids=candidate_ids, max_posts=max_posts
        )
        quote_ids = {qid for post in thread_posts for qid in post.quoted_post_ids}
        missing = sorted(qid for qid in quote_ids if qid not in snapshots.posts)
        for start in range(0, len(missing), 100):
            chunk = missing[start : start + 100]
            payload = get(
                f"{base_url}/tweets",
                {**_LOOKUP_PARAMS, "ids": ",".join(chunk)},
                "lookup_quotes",
            )
            snapshots.absorb(payload)
            unavailable_quote_ids.update(_unavailable_post_ids(payload))

    root = snapshots.posts.get(root.id, root)
    anchor_id = thread_posts[0].id if thread_posts else root.id
    return XAuthorThreadSnapshot(
        requested_post_id=root.id,
        conversation_id=root.conversation_id or root.id,
        canonical_anchor_post_id=anchor_id,
        canonical_url=canonical_x_post_url(anchor_id),
        author=author,
        posts=tuple(thread_posts),
        quote_references=_quote_references(snapshots, quote_ids, unavailable_quote_ids),
        users=snapshots.users,
        media=snapshots.media,
    )


def fetch_single_post_snapshot(post_id: str) -> XSinglePostSnapshot:
    """Look one public post up by id."""
    base_url, headers, deadline = _request_config("lookup_x_post")
    snapshots = _Snapshots()
    with httpx.Client(trust_env=False, headers=headers) as client:
        snapshots.absorb(
            _json_getter(client, deadline)(
                f"{base_url}/tweets/{post_id}", _LOOKUP_PARAMS, "lookup_x_post"
            )
        )
    post = snapshots.posts.get(post_id)
    if post is None:
        raise _unavailable("X API returned no post data.", "lookup_x_post")
    if post.author_id not in snapshots.users:
        raise _unavailable("X API returned no author data.", "lookup_x_post")
    return XSinglePostSnapshot(
        requested_post_id=post.id,
        canonical_url=canonical_x_post_url(post.id),
        post=post,
        users=snapshots.users,
        media=snapshots.media,
    )


def _request_config(operation: str) -> tuple[str, dict[str, str], float]:
    settings = get_settings()
    bearer_token = (settings.x_api_bearer_token or "").strip()
    if not bearer_token:
        raise XProviderError(
            XProviderErrorCode.AUTH_REJECTED,
            "X API bearer token is not configured.",
            operation=operation,
        )
    return (
        settings.x_api_base_url.rstrip("/"),
        {
            "Authorization": f"Bearer {bearer_token}",
            "User-Agent": "Nexus Media Ingestion/1.0",
        },
        perf_counter() + float(settings.x_api_timeout_seconds),
    )


def _json_getter(
    client: httpx.Client, deadline: float
) -> Callable[[str, Mapping[str, str], str], dict[str, Any]]:
    """Bind one GET-JSON-with-backoff to this operation's shared deadline."""

    def get(url: str, params: Mapping[str, str], operation: str) -> dict[str, Any]:
        for attempt_index in range(len(_RETRY_BACKOFF_SECONDS) + 1):
            remaining = deadline - perf_counter()
            if remaining <= 0:
                raise XProviderError(
                    XProviderErrorCode.TIMEOUT, "X API request timed out.", operation=operation
                )
            try:
                response = client.get(
                    url,
                    params=dict(params),
                    timeout=httpx.Timeout(remaining, connect=min(5.0, remaining)),
                )
                if 200 <= response.status_code < 300:
                    return _decode_json(response, operation)
                error = _http_error(response, operation)
            except httpx.TimeoutException:
                error = XProviderError(
                    XProviderErrorCode.TIMEOUT, "X API request timed out.", operation=operation
                )
            except httpx.RequestError:
                error = XProviderError(
                    XProviderErrorCode.UNAVAILABLE, "X API request failed.", operation=operation
                )
            delay = _retry_delay(error, attempt_index, deadline)
            if delay is None:
                raise error
            logger.warning(
                "x_provider_request_retry",
                operation=operation,
                attempt=attempt_index + 1,
                provider_status_code=error.provider_status_code,
                provider_error_title=error.provider_error_title,
                retry_after_seconds=error.retry_after_seconds,
                delay_seconds=delay,
            )
            sleep(delay)
        raise XProviderError(
            XProviderErrorCode.UNAVAILABLE, "X API request failed.", operation=operation
        )

    return get


def _decode_json(response: httpx.Response, operation: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise _unavailable("X API returned invalid JSON.", operation) from exc
    if not isinstance(payload, dict):
        raise _unavailable("X API returned invalid JSON.", operation)
    return payload


def _http_error(response: httpx.Response, operation: str) -> XProviderError:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    title: str | None = None
    error_type: str | None = None
    if isinstance(payload, dict):
        title = _text(payload.get("title"))
        error_type = _text(payload.get("type"))
        errors = payload.get("errors")
        if not title and isinstance(errors, list) and errors and isinstance(errors[0], dict):
            title = _text(errors[0].get("title"))
            error_type = _text(errors[0].get("type")) or error_type

    status = response.status_code
    if status == 402 and (
        title == "CreditsDepleted" or (error_type or "").endswith("CreditsDepleted")
    ):
        code = XProviderErrorCode.CREDITS_DEPLETED
    elif status == 403 and operation in _POST_LOOKUP_OPERATIONS:
        code = XProviderErrorCode.POST_UNAVAILABLE
    elif status in {401, 403}:
        code = XProviderErrorCode.AUTH_REJECTED
    elif status == 429:
        code = XProviderErrorCode.RATE_LIMITED
    elif status == 404:
        code = XProviderErrorCode.POST_UNAVAILABLE
    else:
        code = XProviderErrorCode.UNAVAILABLE

    retry_after: int | None = None
    raw_retry_after = response.headers.get("retry-after")
    if raw_retry_after:
        try:
            retry_after = max(0, int(float(raw_retry_after)))
        except ValueError:
            retry_after = None
    return XProviderError(
        code,
        f"X API returned status {status}.",
        operation=operation,
        provider_status_code=status,
        provider_error_type=error_type,
        provider_error_title=title,
        retry_after_seconds=retry_after,
    )


def _retry_delay(error: XProviderError, attempt_index: int, deadline: float) -> float | None:
    if attempt_index >= len(_RETRY_BACKOFF_SECONDS):
        return None
    if error.provider_status_code is not None:
        retryable = error.provider_status_code in _RETRYABLE_STATUS
    else:
        retryable = error.code in {XProviderErrorCode.TIMEOUT, XProviderErrorCode.UNAVAILABLE}
    if not retryable:
        return None
    delay = _RETRY_BACKOFF_SECONDS[attempt_index]
    if error.retry_after_seconds is not None:
        delay = min(max(0, error.retry_after_seconds), 10)
    return None if perf_counter() + delay >= deadline else delay


def _unavailable(message: str, operation: str) -> XProviderError:
    return XProviderError(XProviderErrorCode.UNAVAILABLE, message, operation=operation)


def _decode[T](adapter: TypeAdapter[T], value: Any) -> list[T]:
    """Decode a payload list, skipping items that do not satisfy the model."""
    items = [value] if isinstance(value, dict) else value if isinstance(value, list) else []
    decoded: list[T] = []
    for item in items:
        try:
            decoded.append(adapter.validate_python(item))
        except ValidationError:
            continue
    return decoded


def _merge_posts(existing: XPostSnapshot, post: XPostSnapshot) -> XPostSnapshot:
    """Later payloads may carry a fuller version of a post already seen."""
    return post.model_copy(
        update={
            "author_id": post.author_id or existing.author_id,
            "text": post.text or existing.text,
            "created_at": post.created_at or existing.created_at,
            "conversation_id": post.conversation_id or existing.conversation_id,
            "referenced_tweets": _unique(
                (*existing.referenced_tweets, *post.referenced_tweets),
                lambda ref: (ref.type, ref.id),
            ),
            "media_keys": tuple(dict.fromkeys((*existing.media_keys, *post.media_keys))),
            "urls": _unique(
                (*existing.urls, *post.urls), lambda entity: entity.expanded_url or entity.url
            ),
        }
    )


def _unique[T](items: tuple[T, ...], key: Callable[[T], object]) -> tuple[T, ...]:
    first_seen: dict[object, T] = {}
    for item in items:
        first_seen.setdefault(key(item), item)
    return tuple(first_seen.values())


def _quote_references(
    snapshots: _Snapshots, quote_ids: set[str], unavailable_ids: set[str]
) -> dict[str, XQuoteReference]:
    references: dict[str, XQuoteReference] = {}
    for quote_id in quote_ids:
        quoted = snapshots.posts.get(quote_id)
        if quoted is not None:
            if quoted.author_id not in snapshots.users:
                raise _unavailable(
                    f"X API returned no author data for quoted post {quote_id}.", "lookup_quotes"
                )
            references[quote_id] = XResolvedQuoteReference(post=quoted)
        elif quote_id in unavailable_ids:
            references[quote_id] = XUnavailableQuoteReference(
                post_id=quote_id, canonical_url=canonical_x_post_url(quote_id)
            )
        else:
            raise _unavailable(
                f"X API returned neither post data nor a terminal error for quoted post"
                f" {quote_id}.",
                "lookup_quotes",
            )
    return references


def _unavailable_post_ids(payload: Mapping[str, Any]) -> set[str]:
    errors = payload.get("errors")
    post_ids: set[str] = set()
    for item in errors if isinstance(errors, list) else []:
        if not isinstance(item, dict):
            continue
        if not (_text(item.get("type")) or "").endswith(_UNAVAILABLE_ERROR_SUFFIXES):
            continue
        post_id = _text(item.get("resource_id")) or _text(item.get("value"))
        if post_id:
            post_ids.add(post_id)
    return post_ids


def _select_thread_posts(
    posts: Mapping[str, XPostSnapshot],
    *,
    root: XPostSnapshot,
    candidate_ids: set[str],
    max_posts: int,
) -> list[XPostSnapshot]:
    """The author's own reply chain rooted at the conversation, in time order."""
    conversation_id = root.conversation_id or root.id
    candidates = {
        post_id: post
        for post_id, post in posts.items()
        if post_id in candidate_ids
        and post.author_id == root.author_id
        and (post.id == root.id or post.conversation_id == conversation_id)
    }
    included = {conversation_id if conversation_id in candidates else root.id}
    if root.id in candidates:
        included.add(root.id)
    grew = True
    while grew:
        grew = False
        for post_id, post in candidates.items():
            if post_id in included:
                continue
            if any(
                ref.type == "replied_to" and ref.id in included for ref in post.referenced_tweets
            ):
                included.add(post_id)
                grew = True

    thread_posts = sorted(
        (post for post_id, post in candidates.items() if post_id in included), key=_sort_key
    )[:max_posts]
    if root.id not in {post.id for post in thread_posts}:
        thread_posts.insert(0, root)
    return thread_posts


def _sort_key(post: XPostSnapshot) -> tuple[str, int]:
    return (post.created_at or "", int(post.id) if post.id.isdecimal() else 0)


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None
