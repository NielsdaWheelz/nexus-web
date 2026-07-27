"""Focused tests for stored X quote-reference rendering."""

import pytest

from nexus.services.x_rendering import (
    post_description,
    render_author_thread_fragment_html,
    render_single_post_html,
    thread_description,
)
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XPostReference,
    XPostSnapshot,
    XResolvedQuoteReference,
    XSinglePostSnapshot,
    XUrlEntity,
    XUserSnapshot,
)

pytestmark = pytest.mark.unit


def _quote_snapshot() -> tuple[XAuthorThreadSnapshot, XSinglePostSnapshot]:
    parent = XPostSnapshot(
        id="1234567890",
        author_id="10",
        text=("Read this https://t.co/source and this https://t.co/other-x https://t.co/quoted"),
        created_at="2026-07-27T12:00:00.000Z",
        conversation_id="1234567890",
        referenced_tweets=(XPostReference(type="quoted", id="4444444444"),),
        media_keys=(),
        urls=(
            XUrlEntity(
                url="https://t.co/source",
                expanded_url="https://example.com/source",
                display_url="example.com/source",
                title=None,
            ),
            XUrlEntity(
                url="https://t.co/other-x",
                expanded_url="https://x.com/i/status/9999999999",
                display_url="x.com/i/status/9999999999",
                title=None,
            ),
            XUrlEntity(
                url="https://t.co/quoted",
                expanded_url="https://twitter.com/grace/status/4444444444",
                display_url="twitter.com/grace/status/4444444444",
                title=None,
            ),
        ),
    )
    quote = XPostSnapshot(
        id="4444444444",
        author_id="20",
        text="Quoted body.",
        created_at="2026-07-27T11:00:00.000Z",
        conversation_id="4444444444",
        referenced_tweets=(),
        media_keys=(),
        urls=(),
    )
    users = {
        "10": XUserSnapshot(id="10", name="Ada Lovelace", username="ada"),
        "20": XUserSnapshot(id="20", name="Grace Hopper", username="grace"),
    }
    return (
        XAuthorThreadSnapshot(
            requested_post_id=parent.id,
            conversation_id=parent.id,
            canonical_anchor_post_id=parent.id,
            canonical_url=parent.permalink,
            author=users["10"],
            posts=(parent,),
            quote_references={quote.id: XResolvedQuoteReference(post=quote)},
            users=users,
            media={},
        ),
        XSinglePostSnapshot(
            requested_post_id=parent.id,
            canonical_url=parent.permalink,
            post=parent,
            users=users,
            media={},
        ),
    )


def test_parent_quote_reference_omits_quote_url_entity_but_keeps_other_links():
    thread, _single = _quote_snapshot()

    fragment = render_author_thread_fragment_html(thread)[0]

    assert "https://t.co/quoted" not in fragment.html
    assert "twitter.com/grace/status/4444444444" not in fragment.html
    assert fragment.html.count("Quoted X post by @grace — Open in Nexus") == 1
    assert "https://t.co/source" in fragment.html
    assert 'href="https://example.com/source"' in fragment.html
    assert "https://t.co/other-x" in fragment.html
    assert 'href="https://x.com/i/status/9999999999"' in fragment.html
    assert thread_description(thread) == (
        "Read this https://t.co/source and this https://t.co/other-x"
    )


def test_child_external_quote_reference_replaces_the_quote_url_entity_once():
    _thread, single = _quote_snapshot()

    rendered = render_single_post_html(
        single.post,
        users=single.users,
        media=single.media,
    )

    assert "https://t.co/quoted" not in rendered
    assert "twitter.com/grace/status/4444444444" not in rendered
    assert rendered.count('href="https://x.com/i/status/4444444444"') == 1
    assert rendered.count("Quotes another X post — Open on X") == 1
    assert "https://t.co/source" in rendered
    assert 'href="https://example.com/source"' in rendered
    assert "https://t.co/other-x" in rendered
    assert 'href="https://x.com/i/status/9999999999"' in rendered
    assert post_description(single.post) == (
        "Read this https://t.co/source and this https://t.co/other-x"
    )


def test_quote_occurrence_key_is_stable_when_an_earlier_quote_is_inserted():
    thread, _single = _quote_snapshot()
    parent = thread.posts[0]
    quote = thread.quote_references["4444444444"]
    earlier = XPostSnapshot(
        id="1111111111",
        author_id=parent.author_id,
        text="Earlier quote.",
        created_at="2026-07-27T11:30:00.000Z",
        conversation_id=parent.conversation_id,
        referenced_tweets=(XPostReference(type="quoted", id="2222222222"),),
        media_keys=(),
        urls=(),
    )
    earlier_quote = XPostSnapshot(
        id="2222222222",
        author_id="20",
        text="Earlier quoted body.",
        created_at="2026-07-27T11:00:00.000Z",
        conversation_id="2222222222",
        referenced_tweets=(),
        media_keys=(),
        urls=(),
    )
    reordered = XAuthorThreadSnapshot(
        requested_post_id=thread.requested_post_id,
        conversation_id=thread.conversation_id,
        canonical_anchor_post_id=thread.canonical_anchor_post_id,
        canonical_url=thread.canonical_url,
        author=thread.author,
        posts=(earlier, parent),
        quote_references={
            "2222222222": XResolvedQuoteReference(post=earlier_quote),
            "4444444444": quote,
        },
        users=thread.users,
        media=thread.media,
    )

    original_occurrence = render_author_thread_fragment_html(thread)[0].quote_occurrences[0]
    reordered_occurrence = render_author_thread_fragment_html(reordered)[1].quote_occurrences[0]

    assert original_occurrence.occurrence_key == "x-quote:1234567890:4444444444"
    assert reordered_occurrence.occurrence_key == original_occurrence.occurrence_key
    assert original_occurrence.ordinal == 0
    assert reordered_occurrence.ordinal == 1
