import pytest

from nexus.services.web_article_structure import add_heading_anchors, prepare_web_article_fragment

pytestmark = pytest.mark.unit


def test_prepare_web_article_fragment_emits_heading_navigation_blocks():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <h1>Article Title</h1>
              <p>Intro.</p>
              <h2>First Section</h2>
              <p>Body.</p>
              <h3>Nested Section</h3>
              <p>Nested body.</p>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        media_title="Article Title",
    )

    assert "nexus-web-heading-0-1-first-section" in prepared.html_sanitized
    assert prepared.canonical_text.startswith("Article Title\n\nIntro.")

    heading_blocks = [block for block in prepared.index_blocks if block.block_kind == "heading"]
    assert [block.section_id for block in heading_blocks] == [
        None,
        "web-heading:0:1:first-section",
        "web-heading:0:2:nested-section",
    ]
    assert [block.depth for block in heading_blocks] == [None, 1, 2]
    assert heading_blocks[1].heading_path == ("First Section",)
    assert heading_blocks[2].heading_path == ("First Section", "Nested Section")

    first = heading_blocks[1]
    assert prepared.canonical_text[first.start_offset : first.end_offset] == ("First Section\n")
    assert (
        next(
            block for block in prepared.fragment_blocks if block.start_offset == first.start_offset
        ).block_type
        == "heading"
    )


def test_add_heading_anchors_is_idempotent_for_generated_ids():
    html = add_heading_anchors("<h2>Section</h2>", fragment_idx=0)

    assert add_heading_anchors(html, fragment_idx=0) == html


def test_prepare_web_article_fragment_extracts_youtube_iframe_as_safe_embed_slot():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <p>Before.</p>
              <iframe
                src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc"
                title="Launch video"
                class="source-widget"
                allow="autoplay"
              ></iframe>
              <p>After.</p>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    assert "<iframe" not in prepared.html_sanitized, prepared.html_sanitized
    assert "allow=" not in prepared.html_sanitized, prepared.html_sanitized
    assert "source-widget" not in prepared.html_sanitized, prepared.html_sanitized
    assert 'data-nexus-document-embed-kind="youtube_video"' in prepared.html_sanitized
    assert "Embedded video: Launch video" in prepared.canonical_text

    assert len(prepared.document_embeds) == 1
    embed = prepared.document_embeds[0]
    assert embed.detected.provider == "youtube"
    assert embed.detected.embed_kind == "video"
    assert embed.detected.source_shape == "iframe"
    assert embed.detected.resolution_status == "pending"
    assert embed.detected.source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert embed.detected.canonical_source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert embed.detected.provider_target_ref == "dQw4w9WgXcQ"
    assert (
        prepared.canonical_text[embed.canonical_start_offset : embed.canonical_end_offset]
        == "Embedded video: Launch video"
    )


def test_prepare_web_article_fragment_extracts_x_blockquote_without_widget_markup():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <blockquote class="twitter-tweet">
                <p>Nexus demo</p>
                <a href="https://twitter.com/nasa/status/1234567890123456789">
                  June 1, 2026
                </a>
              </blockquote>
              <script src="https://platform.twitter.com/widgets.js"></script>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    assert "<blockquote" not in prepared.html_sanitized, prepared.html_sanitized
    assert "<script" not in prepared.html_sanitized, prepared.html_sanitized
    assert "twitter-tweet" not in prepared.html_sanitized, prepared.html_sanitized
    assert 'data-nexus-document-embed-kind="x_post"' in prepared.html_sanitized

    assert len(prepared.document_embeds) == 1
    embed = prepared.document_embeds[0]
    assert embed.detected.provider == "x"
    assert embed.detected.embed_kind == "post"
    assert embed.detected.source_shape == "blockquote"
    assert embed.detected.resolution_status == "pending"
    assert embed.detected.source_url == "https://x.com/i/status/1234567890123456789"
    assert embed.detected.canonical_source_url == "https://x.com/i/status/1234567890123456789"
    assert embed.detected.provider_target_ref == "1234567890123456789"
    assert embed.detected.placeholder_text == "Embedded X post: Nexus demo June 1, 2026"
    assert (
        prepared.canonical_text[embed.canonical_start_offset : embed.canonical_end_offset]
        == embed.detected.placeholder_text
    )


def test_prepare_web_article_fragment_models_unsupported_and_malformed_iframes():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <iframe src="https://player.vimeo.com/video/123"></iframe>
              <iframe title="missing source"></iframe>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    assert "<iframe" not in prepared.html_sanitized, prepared.html_sanitized
    assert "player.vimeo.com/video/123" not in prepared.html_sanitized, prepared.html_sanitized
    assert [embed.detected.placeholder_text for embed in prepared.document_embeds] == [
        "Unsupported embedded content: player.vimeo.com",
        "Embedded content unavailable",
    ]

    unsupported, malformed = prepared.document_embeds
    assert unsupported.detected.provider == "generic"
    assert unsupported.detected.source_shape == "iframe"
    assert unsupported.detected.resolution_status == "unsupported"
    assert unsupported.detected.source_url is None
    assert unsupported.detected.canonical_source_url is None

    assert malformed.detected.provider == "unknown"
    assert malformed.detected.source_shape == "iframe"
    assert malformed.detected.resolution_status == "failed"
    assert malformed.detected.source_url is None
    assert malformed.detected.canonical_source_url is None
    assert malformed.detected.error_code == "missing_src"
    assert (
        prepared.canonical_text[
            unsupported.canonical_start_offset : unsupported.canonical_end_offset
        ]
        == unsupported.detected.placeholder_text
    )
    assert (
        prepared.canonical_text[malformed.canonical_start_offset : malformed.canonical_end_offset]
        == malformed.detected.placeholder_text
    )


def test_prepare_web_article_fragment_rejects_unsafe_iframe_url_without_preserving_href():
    prepared = prepare_web_article_fragment(
        html='<article><iframe src="javascript:alert(1)"></iframe></article>',
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    embed = prepared.document_embeds[0]
    assert embed.detected.resolution_status == "failed"
    assert embed.detected.error_code == "unsafe_url"
    assert embed.detected.source_url is None
    assert embed.detected.canonical_source_url is None
    assert "javascript:" not in prepared.html_sanitized


def test_prepare_web_article_fragment_leaves_plain_x_links_inside_blockquotes_as_links():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <blockquote>
                <p>See this post.</p>
                <a href="https://x.com/nasa/status/1234567890123456789">X link</a>
              </blockquote>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    assert prepared.document_embeds == []
    assert "See this post." in prepared.canonical_text
    assert "https://x.com/nasa/status/1234567890123456789" in prepared.html_sanitized


def test_prepare_web_article_fragment_source_only_embed_is_not_given_fake_inline_location():
    prepared = prepare_web_article_fragment(
        html="<article><p>Readable body.</p></article>",
        embed_source_html="""
            <html><body>
              <article>
                <p>Readable body.</p>
                <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
              </article>
            </body></html>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    embed = prepared.document_embeds[0]
    assert embed.detected.provider == "youtube"
    assert embed.canonical_start_offset is None
    assert embed.canonical_end_offset is None
    assert "data-nexus-document-embed-id" not in prepared.html_sanitized
    assert "Embedded video:" not in prepared.canonical_text


def test_prepare_web_article_fragment_does_not_retain_token_like_embed_url_query_values():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <iframe
                src="https://www.youtube.com/embed/dQw4w9WgXcQ?token=secret"
                title="Launch video"
              ></iframe>
              <blockquote class="twitter-tweet">
                <a href="https://twitter.com/nasa/status/1234567890123456789?s=20&token=secret">
                  X link
                </a>
              </blockquote>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    youtube, x_post = prepared.document_embeds
    assert youtube.detected.source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert x_post.detected.source_url == "https://x.com/i/status/1234567890123456789"
    assert "secret" not in prepared.html_sanitized


def test_prepare_web_article_fragment_bounds_generated_embed_placeholder_text():
    prepared = prepare_web_article_fragment(
        html=f'<article><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="{"A" * 900}"></iframe></article>',
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    embed = prepared.document_embeds[0]
    assert len(embed.detected.placeholder_text) <= 512
    assert len(embed.detected.title or "") <= 300


def test_prepare_web_article_fragment_publishes_reader_content_when_embed_extraction_fails(
    monkeypatch,
):
    def fail_extract(_html, _base_url):
        raise RuntimeError("parser exploded")

    monkeypatch.setattr(
        "nexus.services.web_article_structure.extract_document_embeds",
        fail_extract,
    )

    prepared = prepare_web_article_fragment(
        html="<article><p>Readable body.</p></article>",
        base_url="https://example.com/article",
        fragment_idx=0,
        extract_embeds=True,
    )

    assert prepared.canonical_text == "Readable body."
    assert prepared.document_embeds == []
    assert prepared.document_embed_extraction_error_code == "E_EMBED_EXTRACTION_FAILED"
    assert prepared.document_embed_extraction_error_message == "parser exploded"
