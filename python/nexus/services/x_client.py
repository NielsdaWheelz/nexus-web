"""Official X API client for public post/thread snapshots."""

from __future__ import annotations

from collections.abc import Mapping
from time import perf_counter, sleep

import httpx

from nexus.config import get_settings
from nexus.logging import get_logger
from nexus.services.x_identity import normalize_x_username
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XMediaSnapshot,
    XPostReference,
    XPostSnapshot,
    XProviderError,
    XProviderErrorCode,
    XUrlEntity,
    XUserSnapshot,
    canonical_x_post_url,
)

logger = get_logger(__name__)

_POST_FIELDS = ",".join(
    (
        "id",
        "text",
        "author_id",
        "created_at",
        "conversation_id",
        "referenced_tweets",
        "in_reply_to_user_id",
        "attachments",
        "entities",
        "note_tweet",
        "lang",
        "possibly_sensitive",
    )
)
_POST_EXPANSIONS = ("referenced_tweets.id", "attachments.media_keys")
_USER_EXPANSIONS = ("author_id", "referenced_tweets.id.author_id")
_USER_FIELDS = "id,name,username"
_MEDIA_FIELDS = "media_key,type,url,preview_image_url,alt_text,width,height"
_SEARCH_PAGE_SIZE = 100
_THREAD_SEARCH_SCOPE = "all"
_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_BACKOFF_SECONDS = (0.05, 0.1)


def fetch_author_thread_snapshot(post_id: str) -> XAuthorThreadSnapshot:
    settings = get_settings()
    bearer_token = (settings.x_api_bearer_token or "").strip()
    if not bearer_token:
        raise XProviderError(
            XProviderErrorCode.AUTH_REJECTED,
            "X API bearer token is not configured.",
            operation="lookup_post",
        )

    max_posts = int(settings.x_api_author_thread_max_posts)
    deadline = perf_counter() + float(settings.x_api_timeout_seconds)
    base_url = settings.x_api_base_url.rstrip("/")
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "User-Agent": "Nexus Media Ingestion/1.0",
    }

    accumulator = _XPayloadAccumulator()
    thread_candidate_ids: set[str] = set()
    with httpx.Client(trust_env=False, headers=headers) as client:
        root_payload = _get_json(
            client,
            f"{base_url}/tweets/{post_id}",
            params=_post_lookup_params(),
            operation="lookup_post",
            deadline=deadline,
        )
        accumulator.add(root_payload)
        root = _parse_post(root_payload.get("data"))
        if root is None:
            raise _provider_unavailable("X API returned no post data.", "lookup_post")

        root_author = accumulator.users.get(root.author_id)
        if root_author is None or not normalize_x_username(root_author.username):
            raise _provider_unavailable("X API returned no author data.", "lookup_post")

        conversation_id = root.conversation_id or root.id
        thread_candidate_ids = {root.id}
        next_token: str | None = None
        while len(thread_candidate_ids) < max_posts:
            remaining = max_posts - len(thread_candidate_ids)
            search_payload = _get_json(
                client,
                f"{base_url}/tweets/search/{_THREAD_SEARCH_SCOPE}",
                params=_thread_search_params(
                    conversation_id=conversation_id,
                    username=root_author.username,
                    max_results=max(10, min(_SEARCH_PAGE_SIZE, remaining)),
                    next_token=next_token,
                ),
                operation="search_author_thread",
                deadline=deadline,
            )
            accumulator.add(search_payload)
            for post in _parse_posts(search_payload.get("data")):
                thread_candidate_ids.add(post.id)
            meta = search_payload.get("meta")
            next_token = meta.get("next_token") if isinstance(meta, dict) else None
            if not next_token:
                break

        quote_ids = _quoted_post_ids(accumulator.posts, thread_candidate_ids)
        missing_quote_ids = sorted(qid for qid in quote_ids if qid not in accumulator.posts)
        for chunk in _chunks(missing_quote_ids, 100):
            accumulator.add(
                _get_json(
                    client,
                    f"{base_url}/tweets",
                    params={**_post_lookup_params(), "ids": ",".join(chunk)},
                    operation="lookup_quotes",
                    deadline=deadline,
                )
            )

    root = accumulator.posts.get(post_id)
    if root is None:
        raise _provider_unavailable("X API returned no post data.", "lookup_post")
    root_author = accumulator.users.get(root.author_id)
    if root_author is None:
        raise _provider_unavailable("X API returned no author data.", "lookup_post")

    thread_posts = _select_author_thread_posts(
        accumulator.posts,
        root=root,
        candidate_ids=thread_candidate_ids,
        max_posts=max_posts,
    )
    canonical_anchor_post_id = thread_posts[0].id if thread_posts else root.id
    quoted_posts = {
        quote_id: accumulator.posts[quote_id]
        for quote_id in _quoted_post_ids(dict((post.id, post) for post in thread_posts))
        if quote_id in accumulator.posts
    }

    return XAuthorThreadSnapshot(
        requested_post_id=root.id,
        conversation_id=root.conversation_id or root.id,
        canonical_anchor_post_id=canonical_anchor_post_id,
        canonical_url=canonical_x_post_url(canonical_anchor_post_id),
        author=root_author,
        posts=tuple(thread_posts),
        quoted_posts=quoted_posts,
        users=accumulator.users,
        media=accumulator.media,
    )


def _post_lookup_params() -> dict[str, str]:
    return {
        "tweet.fields": _POST_FIELDS,
        "expansions": ",".join((*_POST_EXPANSIONS, *_USER_EXPANSIONS)),
        "media.fields": _MEDIA_FIELDS,
        "user.fields": _USER_FIELDS,
    }


def _thread_search_params(
    *,
    conversation_id: str,
    username: str,
    max_results: int,
    next_token: str | None,
) -> dict[str, str]:
    conversation_id = conversation_id.strip()
    username = normalize_x_username(username) or ""
    if not conversation_id.isdecimal() or not username:
        raise _provider_unavailable(
            "X API author-thread search requires a post conversation ID and author username.",
            "search_author_thread",
        )

    params = {
        **_post_lookup_params(),
        "query": f"conversation_id:{conversation_id} from:{username}",
        "max_results": str(max_results),
    }
    if next_token:
        params["next_token"] = next_token
    return params


def _get_json(
    client: httpx.Client,
    url: str,
    *,
    params: Mapping[str, str],
    operation: str,
    deadline: float,
) -> dict[str, object]:
    attempt_index = 0
    while True:
        remaining = deadline - perf_counter()
        if remaining <= 0:
            raise XProviderError(
                XProviderErrorCode.TIMEOUT,
                "X API request timed out.",
                operation=operation,
            )
        try:
            response = client.get(
                url,
                params=params,
                timeout=httpx.Timeout(remaining, connect=min(5.0, remaining)),
            )
        except httpx.TimeoutException as exc:
            error = XProviderError(
                XProviderErrorCode.TIMEOUT,
                "X API request timed out.",
                operation=operation,
            )
            delay = _retry_delay_seconds(error, attempt_index, deadline)
            if delay is None:
                raise error from exc
            _log_retry(operation, error, attempt_index, delay)
            sleep(delay)
            attempt_index += 1
            continue
        except httpx.RequestError as exc:
            error = XProviderError(
                XProviderErrorCode.UNAVAILABLE,
                "X API request failed.",
                operation=operation,
            )
            delay = _retry_delay_seconds(error, attempt_index, deadline)
            if delay is None:
                raise error from exc
            _log_retry(operation, error, attempt_index, delay)
            sleep(delay)
            attempt_index += 1
            continue
        if response.status_code < 200 or response.status_code >= 300:
            error = _provider_http_error(response, operation)
            delay = _retry_delay_seconds(error, attempt_index, deadline)
            if delay is None:
                raise error
            _log_retry(operation, error, attempt_index, delay)
            sleep(delay)
            attempt_index += 1
            continue
        try:
            payload = response.json()
        except ValueError as exc:
            raise _provider_unavailable("X API returned invalid JSON.", operation) from exc
        if not isinstance(payload, dict):
            raise _provider_unavailable("X API returned invalid JSON.", operation)
        return payload


def _provider_http_error(response: httpx.Response, operation: str) -> XProviderError:
    title: str | None = None
    error_type: str | None = None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        title = _string(payload.get("title"))
        error_type = _string(payload.get("type"))
        errors = payload.get("errors")
        if not title and isinstance(errors, list) and errors and isinstance(errors[0], dict):
            title = _string(errors[0].get("title"))
            error_type = _string(errors[0].get("type")) or error_type

    if response.status_code == 402 and (
        title == "CreditsDepleted" or (error_type or "").endswith("CreditsDepleted")
    ):
        code = XProviderErrorCode.CREDITS_DEPLETED
    elif response.status_code in {401, 403}:
        code = XProviderErrorCode.AUTH_REJECTED
    elif response.status_code == 429:
        code = XProviderErrorCode.RATE_LIMITED
    elif response.status_code == 404:
        code = XProviderErrorCode.POST_UNAVAILABLE
    else:
        code = XProviderErrorCode.UNAVAILABLE

    retry_after = None
    if response.headers.get("retry-after"):
        try:
            retry_after = max(0, int(float(response.headers["retry-after"])))
        except ValueError:
            retry_after = None

    return XProviderError(
        code,
        f"X API returned status {response.status_code}.",
        operation=operation,
        provider_status_code=response.status_code,
        provider_error_type=error_type,
        provider_error_title=title,
        retry_after_seconds=retry_after,
    )


def _provider_unavailable(message: str, operation: str) -> XProviderError:
    return XProviderError(XProviderErrorCode.UNAVAILABLE, message, operation=operation)


def _retry_delay_seconds(
    error: XProviderError,
    attempt_index: int,
    deadline: float,
) -> float | None:
    if attempt_index >= len(_RETRY_BACKOFF_SECONDS):
        return None
    retryable = error.code in {XProviderErrorCode.TIMEOUT, XProviderErrorCode.UNAVAILABLE}
    if error.provider_status_code is not None:
        retryable = error.provider_status_code in _RETRYABLE_STATUS
    if not retryable:
        return None
    delay = _RETRY_BACKOFF_SECONDS[attempt_index]
    if error.retry_after_seconds is not None:
        delay = min(max(0, error.retry_after_seconds), 10)
    if perf_counter() + delay >= deadline:
        return None
    return delay


def _log_retry(
    operation: str,
    error: XProviderError,
    attempt_index: int,
    delay_seconds: float,
) -> None:
    logger.warning(
        "x_provider_request_retry",
        operation=operation,
        attempt=attempt_index + 1,
        provider_status_code=error.provider_status_code,
        provider_error_title=error.provider_error_title,
        retry_after_seconds=error.retry_after_seconds,
        delay_seconds=delay_seconds,
    )


class _XPayloadAccumulator:
    def __init__(self) -> None:
        self.posts: dict[str, XPostSnapshot] = {}
        self.users: dict[str, XUserSnapshot] = {}
        self.media: dict[str, XMediaSnapshot] = {}

    def add(self, payload: Mapping[str, object]) -> None:
        for post in _parse_posts(payload.get("data")):
            self._remember_post(post)
        includes = payload.get("includes")
        if not isinstance(includes, dict):
            return
        for post in _parse_posts(includes.get("tweets")):
            self._remember_post(post)
        for user in _parse_users(includes.get("users")):
            self.users[user.id] = user
        for item in _parse_media(includes.get("media")):
            self.media[item.media_key] = item

    def _remember_post(self, post: XPostSnapshot) -> None:
        existing = self.posts.get(post.id)
        if existing is None:
            self.posts[post.id] = post
            return
        self.posts[post.id] = XPostSnapshot(
            id=post.id,
            author_id=post.author_id or existing.author_id,
            text=post.text or existing.text,
            created_at=post.created_at or existing.created_at,
            conversation_id=post.conversation_id or existing.conversation_id,
            referenced_tweets=_merge_references(
                existing.referenced_tweets,
                post.referenced_tweets,
            ),
            media_keys=_merge_strings(existing.media_keys, post.media_keys),
            urls=_merge_urls(existing.urls, post.urls),
        )


def _parse_posts(value: object) -> list[XPostSnapshot]:
    if isinstance(value, dict):
        post = _parse_post(value)
        return [post] if post is not None else []
    if not isinstance(value, list):
        return []
    return [post for item in value if (post := _parse_post(item)) is not None]


def _parse_post(value: object) -> XPostSnapshot | None:
    if not isinstance(value, dict):
        return None
    post_id = _string(value.get("id"))
    author_id = _string(value.get("author_id"))
    if post_id is None or author_id is None:
        return None
    note_tweet = value.get("note_tweet")
    text = _string(note_tweet.get("text")) if isinstance(note_tweet, dict) else None
    return XPostSnapshot(
        id=post_id,
        author_id=author_id,
        text=text or _string(value.get("text")) or "",
        created_at=_string(value.get("created_at")),
        conversation_id=_string(value.get("conversation_id")),
        referenced_tweets=tuple(_parse_references(value.get("referenced_tweets"))),
        media_keys=tuple(_parse_media_keys(value.get("attachments"))),
        urls=tuple(_parse_url_entities(value.get("entities"))),
    )


def _parse_references(value: object) -> list[XPostReference]:
    if not isinstance(value, list):
        return []
    refs: list[XPostReference] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        ref_type = _string(item.get("type"))
        ref_id = _string(item.get("id"))
        if ref_type and ref_id:
            refs.append(XPostReference(type=ref_type, id=ref_id))
    return refs


def _parse_media_keys(value: object) -> list[str]:
    if not isinstance(value, dict):
        return []
    media_keys = value.get("media_keys")
    if not isinstance(media_keys, list):
        return []
    return [key for key in (_string(item) for item in media_keys) if key]


def _parse_url_entities(value: object) -> list[XUrlEntity]:
    if not isinstance(value, dict):
        return []
    urls = value.get("urls")
    if not isinstance(urls, list):
        return []
    entities: list[XUrlEntity] = []
    for item in urls:
        if not isinstance(item, dict):
            continue
        url = _string(item.get("url"))
        if not url:
            continue
        entities.append(
            XUrlEntity(
                url=url,
                expanded_url=_string(item.get("expanded_url")),
                display_url=_string(item.get("display_url")),
                title=_string(item.get("title")),
            )
        )
    return entities


def _parse_users(value: object) -> list[XUserSnapshot]:
    if not isinstance(value, list):
        return []
    users: list[XUserSnapshot] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        user_id = _string(item.get("id"))
        username = normalize_x_username(_string(item.get("username")))
        if user_id and username:
            users.append(
                XUserSnapshot(
                    id=user_id,
                    name=_string(item.get("name")) or username,
                    username=username,
                )
            )
    return users


def _parse_media(value: object) -> list[XMediaSnapshot]:
    if not isinstance(value, list):
        return []
    media: list[XMediaSnapshot] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        media_key = _string(item.get("media_key"))
        media_type = _string(item.get("type"))
        if media_key and media_type:
            media.append(
                XMediaSnapshot(
                    media_key=media_key,
                    type=media_type,
                    url=_string(item.get("url")),
                    preview_image_url=_string(item.get("preview_image_url")),
                    alt_text=_string(item.get("alt_text")),
                )
            )
    return media


def _quoted_post_ids(
    posts: Mapping[str, XPostSnapshot],
    post_ids: set[str] | None = None,
) -> set[str]:
    selected = posts.values() if post_ids is None else (posts[post_id] for post_id in post_ids)
    quote_ids: set[str] = set()
    for post in selected:
        quote_ids.update(post.quoted_post_ids)
    return quote_ids


def _select_author_thread_posts(
    posts: Mapping[str, XPostSnapshot],
    *,
    root: XPostSnapshot,
    candidate_ids: set[str],
    max_posts: int,
) -> list[XPostSnapshot]:
    conversation_id = root.conversation_id or root.id
    candidates = {
        post_id: post
        for post_id, post in posts.items()
        if post_id in candidate_ids
        and post.author_id == root.author_id
        and (post.id == root.id or post.conversation_id == conversation_id)
    }
    thread_root_id = conversation_id if conversation_id in candidates else root.id
    included_ids = {thread_root_id}
    if root.id in candidates:
        included_ids.add(root.id)

    changed = True
    while changed:
        changed = False
        for post_id, post in candidates.items():
            if post_id in included_ids:
                continue
            if any(
                ref.type == "replied_to" and ref.id in included_ids
                for ref in post.referenced_tweets
            ):
                included_ids.add(post_id)
                changed = True

    thread_posts = sorted(
        [post for post_id, post in candidates.items() if post_id in included_ids],
        key=_post_sort_key,
    )[:max_posts]
    if root.id not in {post.id for post in thread_posts}:
        thread_posts.insert(0, root)
    return thread_posts


def _merge_references(
    left: tuple[XPostReference, ...],
    right: tuple[XPostReference, ...],
) -> tuple[XPostReference, ...]:
    seen: set[tuple[str, str]] = set()
    merged: list[XPostReference] = []
    for ref in (*left, *right):
        key = (ref.type, ref.id)
        if key in seen:
            continue
        seen.add(key)
        merged.append(ref)
    return tuple(merged)


def _merge_strings(left: tuple[str, ...], right: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys((*left, *right)))


def _merge_urls(
    left: tuple[XUrlEntity, ...], right: tuple[XUrlEntity, ...]
) -> tuple[XUrlEntity, ...]:
    seen: set[str] = set()
    merged: list[XUrlEntity] = []
    for entity in (*left, *right):
        key = entity.expanded_url or entity.url
        if key in seen:
            continue
        seen.add(key)
        merged.append(entity)
    return tuple(merged)


def _post_sort_key(post: XPostSnapshot) -> tuple[str, int]:
    try:
        numeric_id = int(post.id)
    except ValueError:
        numeric_id = 0
    return (post.created_at or "", numeric_id)


def _chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[idx : idx + size] for idx in range(0, len(items), size)]


def _string(value: object) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None
