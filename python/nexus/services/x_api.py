"""Official X API ingestion helpers for public post/thread snapshots."""

from __future__ import annotations

import html as html_lib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

import httpx

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode

X_AUTHOR_THREAD_PROVIDER_ID_PREFIX = "thread:"

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
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


@dataclass(frozen=True)
class XUserSnapshot:
    id: str
    name: str
    username: str


@dataclass(frozen=True)
class XPostReference:
    type: str
    id: str


@dataclass(frozen=True)
class XUrlEntity:
    url: str
    expanded_url: str | None
    display_url: str | None
    title: str | None


@dataclass(frozen=True)
class XMediaSnapshot:
    media_key: str
    type: str
    url: str | None
    preview_image_url: str | None
    alt_text: str | None


@dataclass(frozen=True)
class XPostSnapshot:
    id: str
    author_id: str
    text: str
    created_at: str | None
    conversation_id: str | None
    referenced_tweets: tuple[XPostReference, ...]
    media_keys: tuple[str, ...]
    urls: tuple[XUrlEntity, ...]

    @property
    def permalink(self) -> str:
        return canonical_x_post_url(self.id)

    @property
    def quoted_post_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.referenced_tweets if ref.type == "quoted")


@dataclass(frozen=True)
class XAuthorThreadSnapshot:
    root_post_id: str
    canonical_url: str
    author: XUserSnapshot
    posts: tuple[XPostSnapshot, ...]
    quoted_posts: Mapping[str, XPostSnapshot]
    users: Mapping[str, XUserSnapshot]
    media: Mapping[str, XMediaSnapshot]


def x_author_thread_provider_id(post_id: str) -> str:
    return f"{X_AUTHOR_THREAD_PROVIDER_ID_PREFIX}{post_id}"


def canonical_x_post_url(post_id: str) -> str:
    return f"https://x.com/i/status/{post_id}"


def fetch_author_thread_snapshot(
    post_id: str,
    *,
    username_hint: str | None = None,
) -> XAuthorThreadSnapshot:
    username_hint = _normalize_username(username_hint)
    settings = get_settings()
    bearer_token = (settings.x_api_bearer_token or "").strip()
    if not bearer_token:
        raise ApiError(
            ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            "X API bearer token is not configured.",
        )

    max_posts = int(settings.x_api_author_thread_max_posts)
    timeout = httpx.Timeout(
        float(settings.x_api_timeout_seconds),
        connect=min(5.0, float(settings.x_api_timeout_seconds)),
    )
    base_url = settings.x_api_base_url.rstrip("/")
    include_user_expansions = bool(settings.x_api_include_user_expansions)
    root_needs_user_expansion = include_user_expansions or not username_hint
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "User-Agent": "Nexus Media Ingestion/1.0",
    }

    accumulator = _XPayloadAccumulator()
    try:
        with httpx.Client(timeout=timeout, trust_env=False, headers=headers) as client:
            root_payload = _get_json(
                client,
                f"{base_url}/tweets/{post_id}",
                params=_post_lookup_params(include_users=root_needs_user_expansion),
            )
            accumulator.add(root_payload)
            root = _parse_post(root_payload.get("data"))
            if root is None:
                raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no post data.")

            root_author = accumulator.users.get(root.author_id)
            root_author_username = _normalize_username(
                root_author.username if root_author else None
            )
            root_username = username_hint or root_author_username
            if not root_username:
                raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no author data.")
            if root_author is None:
                root_author = XUserSnapshot(
                    id=root.author_id,
                    name=f"@{root_username}",
                    username=root_username,
                )
                accumulator.users[root.author_id] = root_author

            conversation_id = root.conversation_id or root.id
            thread_candidate_ids = {root.id}
            next_token: str | None = None
            while len(thread_candidate_ids) < max_posts:
                remaining = max_posts - len(thread_candidate_ids)
                params = _thread_search_params(
                    conversation_id=conversation_id,
                    username=root_username,
                    max_results=max(10, min(_SEARCH_PAGE_SIZE, remaining)),
                    next_token=next_token,
                    include_users=include_user_expansions,
                )
                search_payload = _get_json(
                    client,
                    f"{base_url}/tweets/search/{_THREAD_SEARCH_SCOPE}",
                    params=params,
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
                lookup_payload = _get_json(
                    client,
                    f"{base_url}/tweets",
                    params={
                        **_post_lookup_params(include_users=include_user_expansions),
                        "ids": ",".join(chunk),
                    },
                )
                accumulator.add(lookup_payload)
    except httpx.TimeoutException as exc:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "X API request timed out.") from exc
    except httpx.RequestError as exc:
        raise ApiError(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "X API request failed.") from exc

    root = accumulator.posts.get(post_id)
    if root is None:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no post data.")
    root_author = accumulator.users.get(root.author_id)
    if root_author is None:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no author data.")

    thread_posts = _select_author_thread_posts(
        accumulator.posts,
        root=root,
        candidate_ids=thread_candidate_ids,
        max_posts=max_posts,
    )

    quoted_posts = {
        quote_id: accumulator.posts[quote_id]
        for quote_id in _quoted_post_ids(dict((post.id, post) for post in thread_posts))
        if quote_id in accumulator.posts
    }

    return XAuthorThreadSnapshot(
        root_post_id=root.id,
        canonical_url=canonical_x_post_url(root.id),
        author=root_author,
        posts=tuple(thread_posts),
        quoted_posts=quoted_posts,
        users=accumulator.users,
        media=accumulator.media,
    )


def render_author_thread_fragment_html(
    snapshot: XAuthorThreadSnapshot,
    *,
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
) -> list[tuple[XPostSnapshot, str]]:
    rendered: list[tuple[XPostSnapshot, str]] = []
    for idx, post in enumerate(snapshot.posts, start=1):
        raw_html = _render_post_article(
            post,
            users=snapshot.users,
            media=snapshot.media,
            quoted_posts=snapshot.quoted_posts,
            quoted_media_ids=quoted_media_ids,
            app_public_url=app_public_url,
            ordinal=idx,
        )
        rendered.append((post, raw_html))
    return rendered


def render_single_post_html(
    post: XPostSnapshot,
    *,
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
) -> str:
    return _render_post_article(
        post,
        users=users,
        media=media,
        quoted_posts={},
        quoted_media_ids={},
        app_public_url="",
        ordinal=1,
    )


def thread_title(snapshot: XAuthorThreadSnapshot) -> str:
    return f"X thread by {snapshot.author.name or '@' + snapshot.author.username}".strip()


def post_title(post: XPostSnapshot, users: Mapping[str, XUserSnapshot]) -> str:
    author = users.get(post.author_id)
    if author is not None and author.name:
        return f"X post by {author.name}"
    if author is not None and author.username:
        return f"X post by @{author.username}"
    return f"X post {post.id}"


def thread_description(snapshot: XAuthorThreadSnapshot) -> str:
    return "\n\n".join(post.text for post in snapshot.posts if post.text).strip()[:2000]


def post_description(post: XPostSnapshot) -> str:
    return post.text.strip()[:2000]


def _post_lookup_params(*, include_users: bool) -> dict[str, str]:
    expansions = [*_POST_EXPANSIONS]
    if include_users:
        expansions.extend(_USER_EXPANSIONS)

    params = {
        "tweet.fields": _POST_FIELDS,
        "expansions": ",".join(expansions),
        "media.fields": _MEDIA_FIELDS,
    }
    if include_users:
        params["user.fields"] = _USER_FIELDS
    return params


def _thread_search_params(
    *,
    conversation_id: str,
    username: str,
    max_results: int,
    next_token: str | None,
    include_users: bool,
) -> dict[str, str]:
    conversation_id = conversation_id.strip()
    username = _normalize_username(username) or ""
    if not conversation_id.isdecimal() or not username:
        raise ApiError(
            ApiErrorCode.E_INGEST_FAILED,
            "X API author-thread search requires a post conversation ID and author username.",
        )

    params = {
        **_post_lookup_params(include_users=include_users),
        "query": f"conversation_id:{conversation_id} from:{username}",
        "max_results": str(max_results),
    }
    if next_token:
        params["next_token"] = next_token
    return params


def _normalize_username(username: str | None) -> str | None:
    username = (username or "").strip().removeprefix("@")
    return username if _USERNAME_RE.fullmatch(username) else None


def _get_json(client: httpx.Client, url: str, *, params: Mapping[str, str]) -> dict[str, object]:
    response = client.get(url, params=params)
    if response.status_code in {401, 403, 429}:
        raise ApiError(
            ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            f"X API returned status {response.status_code}.",
        )
    if response.status_code < 200 or response.status_code >= 300:
        raise ApiError(
            ApiErrorCode.E_INGEST_FAILED,
            f"X API returned status {response.status_code}.",
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned invalid JSON.") from exc
    if not isinstance(payload, dict):
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned invalid JSON.")
    return payload


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
    text = None
    if isinstance(note_tweet, dict):
        text = _string(note_tweet.get("text"))
    text = text or _string(value.get("text")) or ""
    return XPostSnapshot(
        id=post_id,
        author_id=author_id,
        text=text,
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
        username = _string(item.get("username"))
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


def _render_post_article(
    post: XPostSnapshot,
    *,
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
    quoted_posts: Mapping[str, XPostSnapshot],
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
    ordinal: int,
) -> str:
    author = users.get(post.author_id)
    author_name = author.name if author is not None else "Unknown author"
    username = author.username if author is not None else ""
    header = [
        f"<h2>Post {ordinal}</h2>",
        "<p>",
        f"<strong>{_esc(author_name)}</strong>",
    ]
    if username:
        header.append(f' <a href="https://x.com/{_attr(username)}">@{_esc(username)}</a>')
    if post.created_at:
        header.append(f" · {_esc(post.created_at)}")
    header.append(f' · <a href="{_attr(post.permalink)}">Open on X</a>')
    header.append("</p>")

    parts = ["<article>", *header, _paragraph(post.text)]
    parts.extend(_render_links(post.urls))
    parts.extend(_render_media(post.media_keys, media))
    for quoted_id in post.quoted_post_ids:
        parts.append(
            _render_quote_block(
                quoted_id,
                quoted_posts=quoted_posts,
                users=users,
                media=media,
                quoted_media_ids=quoted_media_ids,
                app_public_url=app_public_url,
            )
        )
    parts.append("</article>")
    return "".join(parts)


def _render_quote_block(
    quoted_id: str,
    *,
    quoted_posts: Mapping[str, XPostSnapshot],
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
) -> str:
    quoted = quoted_posts.get(quoted_id)
    if quoted is None:
        return (
            "<blockquote>"
            "<p>Quoted post unavailable in this archival snapshot.</p>"
            f'<p><a href="{_attr(canonical_x_post_url(quoted_id))}">Open quoted post on X</a></p>'
            "</blockquote>"
        )

    author = users.get(quoted.author_id)
    author_label = "Unknown author"
    if author is not None:
        author_label = f"{author.name} (@{author.username})"

    link = canonical_x_post_url(quoted.id)
    media_id = quoted_media_ids.get(quoted.id)
    if media_id is not None and app_public_url:
        link = f"{app_public_url.rstrip('/')}/media/{media_id}"

    parts = [
        "<blockquote>",
        f"<p><strong>Quoted post by {_esc(author_label)}</strong></p>",
        _paragraph(quoted.text),
        *_render_links(quoted.urls),
        *_render_media(quoted.media_keys, media),
        f'<p><a href="{_attr(link)}">Open quoted post</a></p>',
        "</blockquote>",
    ]
    return "".join(parts)


def _render_links(urls: tuple[XUrlEntity, ...]) -> list[str]:
    rendered: list[str] = []
    for entity in urls:
        href = entity.expanded_url or entity.url
        label = entity.display_url or entity.title or href
        rendered.append(f'<p><a href="{_attr(href)}">{_esc(label)}</a></p>')
    return rendered


def _render_media(media_keys: tuple[str, ...], media: Mapping[str, XMediaSnapshot]) -> list[str]:
    rendered: list[str] = []
    for media_key in media_keys:
        item = media.get(media_key)
        if item is None:
            continue
        image_url = item.url or item.preview_image_url
        if image_url:
            alt = item.alt_text or item.type
            rendered.append(
                "<figure>"
                f'<img src="{_attr(image_url)}" alt="{_attr(alt)}">'
                f"<figcaption>{_esc(item.type)}</figcaption>"
                "</figure>"
            )
    return rendered


def _paragraph(text: str) -> str:
    if not text.strip():
        return "<p></p>"
    return f"<p>{'<br>'.join(_esc(line) for line in text.splitlines())}</p>"


def _esc(value: str) -> str:
    return html_lib.escape(value, quote=False)


def _attr(value: str) -> str:
    return html_lib.escape(value, quote=True)


def _string(value: object) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None
