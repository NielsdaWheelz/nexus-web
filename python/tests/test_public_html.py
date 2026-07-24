from nexus.services.public_html import (
    sanitize_public_article_html,
    sanitize_public_epub_html,
)


def test_public_article_removes_fragment_only_links() -> None:
    result = sanitize_public_article_html('<p><a href="#footnote">Footnote</a></p>')

    assert 'href="#footnote"' not in result
    assert ">Footnote</a>" in result


def test_public_epub_removes_fragment_only_links() -> None:
    result = sanitize_public_epub_html(
        '<p><a href="#chapter">Chapter</a></p>',
        asset_handle_for_key=lambda _key: None,
    )

    assert 'href="#chapter"' not in result
    assert ">Chapter</a>" in result


def test_public_html_drops_active_embedded_and_form_content() -> None:
    result = sanitize_public_article_html(
        """
        <p>Safe</p>
        <script>alert('secret')</script>
        <style>.x{background:url(https://tracker.example/pixel)}</style>
        <form><input value="secret"><button>Send</button></form>
        <iframe src="https://tracker.example/">frame secret</iframe>
        <embed src="https://tracker.example/plugin">
        """
    )

    assert "Safe" in result
    for forbidden in (
        "script",
        "style",
        "background",
        "tracker.example",
        "form",
        "input",
        "button",
        "iframe",
        "embed",
        "secret",
    ):
        assert forbidden not in result


def test_public_html_removes_inline_execution_style_and_image_fetches() -> None:
    result = sanitize_public_article_html(
        """
        <p onclick="steal()" style="background:url(https://tracker.example/pixel)">
          Safe
          <img src="https://tracker.example/a" srcset="https://tracker.example/b 2x"
               onerror="steal()" style="display:none" alt="cover">
        </p>
        """
    )

    assert "Safe" in result
    assert 'alt="cover"' in result
    for forbidden in ("onclick", "onerror", "style=", "src=", "srcset", "tracker.example"):
        assert forbidden not in result


def test_public_links_strip_unsafe_targets_and_harden_explicit_http_egress() -> None:
    result = sanitize_public_article_html(
        """
        <a href="javascript:alert(1)">js</a>
        <a href="//tracker.example/path">relative</a>
        <a href="https://user:secret@example.org/private">credential</a>
        <a href="/private/path">local</a>
        <a href="https://example.org/read?q=public">safe</a>
        """
    )

    for label in ("js", "relative", "credential", "local"):
        assert f'href="{label}"' not in result
    assert 'href="javascript:' not in result
    assert 'href="//tracker.example' not in result
    assert "user:secret@" not in result
    assert 'href="/private/path"' not in result
    assert 'href="https://example.org/read?q=public"' in result
    assert 'target="_blank"' in result
    assert 'rel="noopener noreferrer"' in result
    assert 'referrerpolicy="no-referrer"' in result


def test_public_epub_emits_only_exact_inert_asset_handles() -> None:
    media_id = "11111111-1111-4111-8111-111111111111"
    canonical_handle = "nxpa1_" + ("A" * 48)
    seen: list[str] = []

    def resolve(key: str) -> str | None:
        seen.append(key)
        if key == "images/cover.png":
            return canonical_handle
        if key == "images/bad.png":
            return "not-a-public-handle"
        return None

    result = sanitize_public_epub_html(
        f"""
        <img src="/api/media/{media_id}/assets/images/cover.png" alt="cover">
        <img src="/api/media/{media_id}/assets/images/bad.png" alt="bad">
        <img src="/api/media/{media_id}/assets/images/cover.png?token=secret" alt="query">
        <img src="https://tracker.example/pixel" alt="remote">
        """,
        asset_handle_for_key=resolve,
    )

    assert seen == ["images/cover.png", "images/bad.png"]
    assert result.count(f'data-nexus-public-asset-handle="{canonical_handle}"') == 1
    assert "not-a-public-handle" not in result
    assert "token=secret" not in result
    assert "tracker.example" not in result
    assert " src=" not in result
