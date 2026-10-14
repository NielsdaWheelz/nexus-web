"""Official X API v2 snapshots of public posts and same-author threads.

Provider failures become their ``E_X_*`` ``ApiError`` where the response is seen.
Transport and retry belong to ``net.http_retry``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    ValidationError,
    model_validator,
)

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.presence import absent, present
from nexus.schemas.x_source import (
    XSourceAttachment,
    XSourceAuthor,
    XSourcePost,
    XSourceReference,
    XSourceSnapshot,
    XSourceUrl,
)
from nexus.services.net.http_retry import get_json_with_retry
from nexus.services.x_identity import x_author_thread_provider_id, x_post_provider_id

logger = get_logger(__name__)

_FIELDS = {
    "tweet.fields": "id,text,author_id,created_at,conversation_id,referenced_tweets,"
    "in_reply_to_user_id,attachments,entities,note_tweet,lang,possibly_sensitive",
    "expansions": "referenced_tweets.id,attachments.media_keys,author_id,"
    "referenced_tweets.id.author_id",
    "media.fields": "media_key,type,url,preview_image_url,alt_text,width,height",
    "user.fields": "id,name,username",
}
_USERNAME = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_UNAVAILABLE_TYPES = ("/resource-not-found", "/not-authorized-for-resource")
_UNAVAILABLE = "X imports are temporarily unavailable."
_MESSAGES = {
    ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_UNAVAILABLE: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_RATE_LIMITED: "X is rate limiting imports.",
    ApiErrorCode.E_X_PROVIDER_TIMEOUT: "X import timed out.",
    ApiErrorCode.E_X_POST_UNAVAILABLE: "That X post is not available.",
}


def _blank_to_none(value: Any) -> Any:
    return (value.strip() or None) if isinstance(value, str) else value


type Text = Annotated[str | None, BeforeValidator(_blank_to_none)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class XReference(_Model):
    type: Literal["quoted", "replied_to", "retweeted"]
    id: str


class XUrlEntity(_Model):
    url: str
    expanded_url: Text = None
    display_url: Text = None
    title: Text = None
    media_key: Text = None


class XMedia(_Model):
    media_key: str
    type: str
    url: Text = None
    preview_image_url: Text = None
    alt_text: Text = None


class XUser(_Model):
    id: str
    name: str = ""
    username: str


class XPost(_Model):
    """One post, flattened from the API's attachments, entities and note_tweet."""

    id: str
    author_id: str
    text: str = ""
    created_at: AwareDatetime | None = None
    lang: Text = None
    conversation_id: Text = None
    referenced_tweets: tuple[XReference, ...] = ()
    media_keys: tuple[str, ...] = ()
    urls: tuple[XUrlEntity, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        raw_note = value.get("note_tweet")
        note = raw_note if isinstance(raw_note, dict) else {}
        raw_text = note.get("text")
        note_text = raw_text if isinstance(raw_text, str) and raw_text.strip() else None
        entities = note.get("entities") if note_text else value.get("entities")
        attachments = value.get("attachments")
        keys = attachments.get("media_keys") if isinstance(attachments, dict) else []
        urls = entities.get("urls") if isinstance(entities, dict) else []
        refs = value.get("referenced_tweets")
        return {
            **value,
            "text": note_text or value.get("text") or "",
            "media_keys": [key for key in _items(keys) if isinstance(key, str) and key],
            "urls": [item for item in _items(urls) if _has_text(item, "url")],
            "referenced_tweets": [
                item for item in _items(refs) if _has_text(item, "type") and _has_text(item, "id")
            ],
        }


@dataclass(frozen=True, slots=True)
class AcquiredXSource:
    provider_id: str
    snapshot: XSourceSnapshot


@dataclass
class _Seen:
    posts: dict[str, XPost]
    users: dict[str, XUser]
    media: dict[str, XMedia]
    unavailable: set[str]


def fetch_author_thread(post_id: str) -> AcquiredXSource:
    """Capture the author's chain and one hop of each retained post's references."""
    max_posts = int(get_settings().x_api_author_thread_max_posts)
    seen = _Seen({}, {}, {}, set())
    root = _lookup(post_id, seen)
    author = seen.users[root.author_id]
    conversation_id = root.conversation_id or root.id
    candidates = {root.id}
    params = {**_FIELDS, "query": f"conversation_id:{conversation_id} from:{author.username}"}
    continuation = True
    while len(candidates) < max_posts:
        params["max_results"] = str(max(10, min(100, max_posts - len(candidates))))
        page = _get("/tweets/search/all", params, "search_author_thread")
        candidates.update(post.id for post in _absorb(page, seen))
        meta = page.get("meta")
        next_token = meta.get("next_token") if isinstance(meta, dict) else None
        continuation = bool(next_token)
        if not next_token:
            break
        params["next_token"] = next_token
    posts, omitted = _thread_posts(
        seen.posts, root=root, candidates=candidates, max_posts=max_posts
    )
    return AcquiredXSource(
        provider_id=x_author_thread_provider_id(author.id, conversation_id),
        snapshot=_snapshot(
            seen,
            posts=posts,
            requested_post_id=post_id,
            source_kind="author_thread",
            enumeration="post_limit" if continuation or omitted else "exhausted",
        ),
    )


def fetch_single_post(post_id: str) -> AcquiredXSource:
    seen = _Seen({}, {}, {}, set())
    root = _lookup(post_id, seen)
    return AcquiredXSource(
        provider_id=x_post_provider_id(post_id),
        snapshot=_snapshot(
            seen,
            posts=[root],
            requested_post_id=post_id,
            source_kind="post",
            enumeration="exhausted",
        ),
    )


def _snapshot(
    seen: _Seen,
    *,
    posts: list[XPost],
    requested_post_id: str,
    source_kind: Literal["author_thread", "post"],
    enumeration: Literal["exhausted", "post_limit"],
) -> XSourceSnapshot:
    direct_ids = {reference.id for post in posts for reference in post.referenced_tweets}
    missing = sorted(
        identity
        for identity in direct_ids
        if identity not in seen.unavailable
        and (identity not in seen.posts or not _has_expansions(seen, seen.posts[identity]))
    )
    for start in range(0, len(missing), 100):
        payload = _get(
            "/tweets", {**_FIELDS, "ids": ",".join(missing[start : start + 100])}, "lookup_context"
        )
        _absorb(payload, seen)
    ids = {post.id for post in posts} | {
        identity for identity in direct_ids if identity in seen.posts
    }
    for identity in ids | direct_ids:
        post = seen.posts.get(identity)
        if post is None:
            if identity in seen.unavailable:
                continue
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "lookup_context")
        if not _has_expansions(seen, post):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "lookup_context")
    normalized = {}
    for identity in ids:
        post = seen.posts[identity]
        author = seen.users[post.author_id]
        normalized[identity] = XSourcePost(
            id=post.id,
            author=XSourceAuthor(id=author.id, name=author.name, username=author.username),
            text=post.text,
            created_at=absent() if post.created_at is None else present(post.created_at),
            language=absent() if post.lang is None else present(post.lang),
            urls=tuple(
                XSourceUrl(
                    url=url.url,
                    expanded_url=absent()
                    if url.expanded_url is None
                    else present(url.expanded_url),
                    display_url=absent() if url.display_url is None else present(url.display_url),
                    title=absent() if url.title is None else present(url.title),
                    attachment_media_key=absent()
                    if url.media_key is None
                    else present(url.media_key),
                )
                for url in post.urls
            ),
            attachments=tuple(
                XSourceAttachment(
                    media_key=item.media_key,
                    type=item.type,
                    url=absent() if item.url is None else present(item.url),
                    preview_image_url=absent()
                    if item.preview_image_url is None
                    else present(item.preview_image_url),
                    alt_text=absent() if item.alt_text is None else present(item.alt_text),
                )
                for key in post.media_keys
                for item in (seen.media[key],)
            ),
            references=tuple(
                XSourceReference(
                    kind=reference.type,
                    post_id=reference.id,
                    availability="available"
                    if reference.id in ids
                    else "unavailable"
                    if reference.id in seen.unavailable
                    else "not_captured",
                )
                for reference in post.referenced_tweets
            ),
        )
    return XSourceSnapshot(
        source_kind=source_kind,
        requested_post_id=requested_post_id,
        primary_post_ids=tuple(post.id for post in posts),
        posts=normalized,
        enumeration=enumeration,
    )


def _has_expansions(seen: _Seen, post: XPost) -> bool:
    return post.author_id in seen.users and all(key in seen.media for key in post.media_keys)


def _handle(value: str | None) -> str | None:
    """Strip a leading ``@`` and accept only a well-formed X handle."""
    username = (value or "").strip().removeprefix("@")
    return username if _USERNAME.fullmatch(username) else None


def _lookup(post_id: str, seen: _Seen) -> XPost:
    payload = _get(f"/tweets/{post_id}", _FIELDS, "lookup_post")
    _absorb(payload, seen)
    post = seen.posts.get(post_id)
    if post is None and post_id in _unavailable_ids(payload):
        raise _error(ApiErrorCode.E_X_POST_UNAVAILABLE, "lookup_post")
    if post is None or post.author_id not in seen.users:
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "lookup_post")
    return post


def _get(path: str, params: Mapping[str, str], operation: str) -> dict[str, Any]:
    settings = get_settings()
    token = (settings.x_api_bearer_token or "").strip()
    if not token:
        raise _error(ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED, operation)
    try:
        return get_json_with_retry(
            settings.x_api_base_url.rstrip("/") + path,
            headers={"Authorization": f"Bearer {token}", "User-Agent": "Nexus Media Ingestion/1.0"},
            params=params,
            timeout_s=float(settings.x_api_timeout_seconds),
            backoff_seconds=(0.05, 0.1),
            error_code=ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            provider_name="x",
            honor_retry_after=True,
        )
    except ApiError as exc:
        cause = exc.__cause__
        if isinstance(cause, httpx.TimeoutException):
            raise _error(ApiErrorCode.E_X_PROVIDER_TIMEOUT, operation) from exc
        if not isinstance(cause, httpx.HTTPStatusError):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, operation) from exc
        status = cause.response.status_code
        if status == 402 and "CreditsDepleted" in cause.response.text:
            code = ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED
        elif status == 404 or (status == 403 and operation == "lookup_post"):
            code = ApiErrorCode.E_X_POST_UNAVAILABLE
        elif status in {401, 403}:
            code = ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED
        elif status == 429:
            code = ApiErrorCode.E_X_PROVIDER_RATE_LIMITED
        else:
            code = ApiErrorCode.E_X_PROVIDER_UNAVAILABLE
        raise _error(code, operation, status=status) from exc


def _error(code: ApiErrorCode, operation: str, *, status: int | None = None) -> ApiError:
    logger.warning(
        "x_provider_failure",
        operation=operation,
        provider_status_code=status,
        api_error_code=code.value,
    )
    return ApiError(code, _MESSAGES[code])


def _absorb(payload: Mapping[str, Any], seen: _Seen) -> list[XPost]:
    """Record every post, user and media item of one payload; return its primary posts."""
    seen.unavailable |= _unavailable_ids(payload)
    raw_includes = payload.get("includes")
    includes = raw_includes if isinstance(raw_includes, dict) else {}
    for post in _decode(XPost, includes.get("tweets")):  # an expansion never replaces a primary
        seen.posts.setdefault(post.id, post)
    data = _decode(XPost, payload.get("data"))
    seen.posts.update((post.id, post) for post in data)
    for user in _decode(XUser, includes.get("users")):
        if handle := _handle(user.username):
            seen.users[user.id] = user.model_copy(update={"username": handle})
    for item in _decode(XMedia, includes.get("media")):
        seen.media[item.media_key] = item
    return data


def _decode[M: _Model](model: type[M], value: Any) -> list[M]:
    """Decode a payload list, skipping items that do not satisfy the model."""
    decoded: list[M] = []
    for item in [value] if isinstance(value, dict) else _items(value):
        try:
            decoded.append(model.model_validate(item))
        except ValidationError:
            continue
    return decoded


def _unavailable_ids(payload: Mapping[str, Any]) -> set[str]:
    """Posts the payload's errors declare not found or not authorized."""
    return {
        post_id
        for error in _items(payload.get("errors"))
        if isinstance(error, dict)
        and (_text(error.get("type")) or "").endswith(_UNAVAILABLE_TYPES)
        and (post_id := _text(error.get("resource_id")) or _text(error.get("value")))
    }


def _thread_posts(
    posts: Mapping[str, XPost], *, root: XPost, candidates: set[str], max_posts: int
) -> tuple[list[XPost], bool]:
    """The author's own reply chain in the conversation, in time order, always with the root."""
    conversation_id = root.conversation_id or root.id
    own = {
        post_id: post
        for post_id, post in posts.items()
        if post_id in candidates
        and post.author_id == root.author_id
        and (post_id == root.id or post.conversation_id == conversation_id)
    }
    included = {root.id, conversation_id if conversation_id in own else root.id}
    grew = True
    while grew:
        grew = False
        for post_id, post in own.items():
            if post_id not in included and any(
                ref.type == "replied_to" and ref.id in included for ref in post.referenced_tweets
            ):
                included.add(post_id)
                grew = True
    thread = sorted((own[post_id] for post_id in included), key=_time_order)
    omitted = len(thread) > max_posts
    if omitted:
        others = [post for post in thread if post.id != root.id][: max_posts - 1]
        thread = sorted([root, *others], key=_time_order)
    return thread, omitted


def _time_order(post: XPost) -> tuple[str, int]:
    return (
        post.created_at.isoformat() if post.created_at is not None else "",
        int(post.id) if post.id.isdecimal() else 0,
    )


def _items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _has_text(item: Any, key: str) -> bool:
    return isinstance(item, dict) and bool(str(item.get(key) or "").strip())


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None
