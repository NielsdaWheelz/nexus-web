"""Official X API v2 snapshots of public posts and same-author threads.

Provider failures become their ``E_X_*`` ``ApiError`` where the response is seen.
Transport and retry belong to ``net.http_retry``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, ValidationError, model_validator

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.net.http_retry import get_json_with_retry

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
    type: str
    id: str


class XUrlEntity(_Model):
    url: str
    expanded_url: Text = None
    display_url: Text = None
    title: Text = None


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
    created_at: Text = None
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
        note_text = str(note.get("text") or "").strip()
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

    @property
    def quoted_post_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.referenced_tweets if ref.type == "quoted")


@dataclass(frozen=True)
class XThread:
    author: XUser
    conversation_id: str
    posts: tuple[XPost, ...]  # the author's reply chain, in time order, holding the root
    quotes: Mapping[str, XPost | None]  # None: X answered that the quoted post is unavailable
    users: Mapping[str, XUser]
    media: Mapping[str, XMedia]


@dataclass(frozen=True)
class XSinglePost:
    post: XPost
    users: Mapping[str, XUser]
    media: Mapping[str, XMedia]


@dataclass
class _Seen:
    posts: dict[str, XPost]
    users: dict[str, XUser]
    media: dict[str, XMedia]


def fetch_author_thread(post_id: str) -> XThread:
    """Look the post up, page the author's conversation, and resolve its quotes."""
    max_posts = int(get_settings().x_api_author_thread_max_posts)
    seen = _Seen({}, {}, {})
    root = _lookup(post_id, seen)
    author = seen.users[root.author_id]
    conversation_id = root.conversation_id or root.id
    candidates = {root.id}
    params = {**_FIELDS, "query": f"conversation_id:{conversation_id} from:{author.username}"}
    while len(candidates) < max_posts:
        params["max_results"] = str(max(10, min(100, max_posts - len(candidates))))
        page = _get("/tweets/search/all", params, "search_author_thread")
        candidates.update(post.id for post in _absorb(page, seen))
        meta = page.get("meta")
        next_token = meta.get("next_token") if isinstance(meta, dict) else None
        if not next_token:
            break
        params["next_token"] = next_token
    posts = _thread_posts(seen.posts, root=root, candidates=candidates, max_posts=max_posts)
    quote_ids = sorted({quote_id for post in posts for quote_id in post.quoted_post_ids})
    missing = [quote_id for quote_id in quote_ids if quote_id not in seen.posts]
    unavailable: set[str] = set()
    for start in range(0, len(missing), 100):
        params = {**_FIELDS, "ids": ",".join(missing[start : start + 100])}
        payload = _get("/tweets", params, "lookup_quotes")
        _absorb(payload, seen)
        unavailable |= _unavailable_ids(payload)
    quotes: dict[str, XPost | None] = {}
    for quote_id in quote_ids:
        quoted = seen.posts.get(quote_id)
        if (quoted is None and quote_id not in unavailable) or (
            quoted is not None and quoted.author_id not in seen.users
        ):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "lookup_quotes")
        quotes[quote_id] = quoted
    return XThread(author, conversation_id, tuple(posts), quotes, seen.users, seen.media)


def fetch_single_post(post_id: str) -> XSinglePost:
    """Look one public post up by id."""
    seen = _Seen({}, {}, {})
    return XSinglePost(_lookup(post_id, seen), seen.users, seen.media)


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
    raw_includes = payload.get("includes")
    includes = raw_includes if isinstance(raw_includes, dict) else {}
    for post in _decode(XPost, includes.get("tweets")):  # an expansion never replaces a primary
        seen.posts.setdefault(post.id, post)
    data = _decode(XPost, payload.get("data"))
    seen.posts.update((post.id, post) for post in data)
    for user in _decode(XUser, includes.get("users")):
        if handle := _handle(user.username):
            seen.users[user.id] = user.model_copy(
                update={"name": user.name or handle, "username": handle}
            )
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
) -> list[XPost]:
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
    if len(thread) > max_posts:
        others = [post for post in thread if post.id != root.id][: max_posts - 1]
        thread = sorted([root, *others], key=_time_order)
    return thread


def _time_order(post: XPost) -> tuple[str, int]:
    return (post.created_at or "", int(post.id) if post.id.isdecimal() else 0)


def _items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _has_text(item: Any, key: str) -> bool:
    return isinstance(item, dict) and bool(str(item.get(key) or "").strip())


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None
