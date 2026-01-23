"""Tests for HTML sanitization per s2_pr04.md spec.

Security fixtures suite:
- Scripts removed
- on* event handlers removed
- javascript: URLs stripped
- style/class/id stripped
- data: URLs blocked
- SVG elements removed
- Images rewritten to proxy
- Link attributes forced (rel includes noopener noreferrer)
"""

import pytest

from nexus.services.sanitize_html import sanitize_html


class TestSecurityFixtures:
    """Tests for XSS and security-related sanitization."""

    def test_script_tags_removed(self):
        """Script tags and content should be completely removed."""
        html = '<p>Hello</p><script>alert("xss")</script><p>World</p>'
        result = sanitize_html(html, "https://example.com")
        assert "<script>" not in result
        assert "alert" not in result
        assert "<p>Hello</p>" in result
        assert "<p>World</p>" in result

    def test_inline_event_handlers_removed(self):
        """All on* event handlers should be removed."""
        html = '<p onclick="evil()">Click me</p>'
        result = sanitize_html(html, "https://example.com")
        assert "onclick" not in result
        assert "<p>Click me</p>" in result

    def test_multiple_event_handlers_removed(self):
        """Multiple different event handlers should all be removed."""
        html = '<div onmouseover="x()" onload="y()" onerror="z()">Content</div>'
        result = sanitize_html(html, "https://example.com")
        assert "onmouseover" not in result
        assert "onload" not in result
        assert "onerror" not in result

    def test_javascript_urls_stripped(self):
        """javascript: URLs should be removed from hrefs."""
        html = '<a href="javascript:alert(1)">Click</a>'
        result = sanitize_html(html, "https://example.com")
        assert "javascript:" not in result
        assert "<a" in result  # Tag preserved but href removed

    def test_data_urls_blocked(self):
        """data: URLs should be blocked."""
        html = '<img src="data:image/png;base64,abc123" />'
        result = sanitize_html(html, "https://example.com")
        assert "data:" not in result

    def test_style_attributes_stripped(self):
        """style attributes should be removed."""
        html = '<p style="color: red; font-size: 24px;">Styled</p>'
        result = sanitize_html(html, "https://example.com")
        assert "style=" not in result
        assert "<p>Styled</p>" in result

    def test_class_attributes_stripped(self):
        """class attributes should be removed."""
        html = '<p class="important highlight">Classed</p>'
        result = sanitize_html(html, "https://example.com")
        assert "class=" not in result

    def test_id_attributes_stripped(self):
        """id attributes should be removed."""
        html = '<p id="main-content">Identified</p>'
        result = sanitize_html(html, "https://example.com")
        assert "id=" not in result

    def test_svg_elements_removed(self):
        """SVG elements should be removed entirely."""
        html = '<p>Before</p><svg><circle cx="50" cy="50" r="40"/></svg><p>After</p>'
        result = sanitize_html(html, "https://example.com")
        assert "<svg>" not in result
        assert "<circle" not in result
        assert "<p>Before</p>" in result
        assert "<p>After</p>" in result

    def test_iframe_elements_removed(self):
        """iframe elements should be removed."""
        html = '<p>Content</p><iframe src="https://evil.com"></iframe>'
        result = sanitize_html(html, "https://example.com")
        assert "<iframe" not in result

    def test_form_elements_removed(self):
        """form elements should be removed."""
        html = '<form action="/steal"><input type="text" /></form>'
        result = sanitize_html(html, "https://example.com")
        assert "<form" not in result

    def test_meta_link_base_removed(self):
        """meta, link, base elements should be removed."""
        html = '<meta charset="utf-8"><link rel="stylesheet"><base href="/">'
        result = sanitize_html(html, "https://example.com")
        assert "<meta" not in result
        assert "<link" not in result
        assert "<base" not in result


class TestImageProxy:
    """Tests for image URL rewriting to proxy."""

    def test_image_rewritten_to_proxy(self):
        """Image src should be rewritten to proxy endpoint."""
        html = '<img src="https://example.com/image.jpg" alt="Test" />'
        result = sanitize_html(html, "https://example.com")
        assert "/media/image?url=" in result
        assert "https%3A%2F%2Fexample.com%2Fimage.jpg" in result
        assert 'alt="Test"' in result

    def test_relative_image_resolved(self):
        """Relative image URLs should be resolved before proxying."""
        html = '<img src="/images/photo.png" />'
        result = sanitize_html(html, "https://example.com/article")
        assert "/media/image?url=" in result
        # URL should be resolved to absolute
        assert "https%3A%2F%2Fexample.com%2Fimages%2Fphoto.png" in result


class TestLinkSanitization:
    """Tests for link attribute sanitization."""

    def test_external_link_gets_security_attrs(self):
        """External links should get noopener, noreferrer, and target="_blank"."""
        html = '<a href="https://external.com/page">Link</a>'
        result = sanitize_html(html, "https://example.com")
        assert 'rel="' in result
        assert "noopener" in result
        assert "noreferrer" in result
        assert 'target="_blank"' in result
        assert 'referrerpolicy="no-referrer"' in result

    def test_relative_link_resolved(self):
        """Relative links should be resolved to absolute URLs."""
        html = '<a href="/path/to/page">Link</a>'
        result = sanitize_html(html, "https://example.com/article")
        assert 'href="https://example.com/path/to/page"' in result

    def test_existing_rel_values_preserved(self):
        """Existing rel values should be preserved and augmented."""
        html = '<a href="https://ext.com" rel="author">Link</a>'
        result = sanitize_html(html, "https://example.com")
        # Should have author plus security values
        assert "noopener" in result
        assert "noreferrer" in result


class TestAllowedElements:
    """Tests that allowed elements are preserved."""

    @pytest.mark.parametrize(
        "tag",
        ["p", "br", "strong", "em", "b", "i", "u", "s", "blockquote", "pre", "code"],
    )
    def test_text_formatting_tags_preserved(self, tag):
        """Text formatting tags should be preserved."""
        html = f"<{tag}>Content</{tag}>"
        result = sanitize_html(html, "https://example.com")
        assert f"<{tag}>" in result or f"<{tag}/>" in result

    @pytest.mark.parametrize("tag", ["h1", "h2", "h3", "h4", "h5", "h6"])
    def test_heading_tags_preserved(self, tag):
        """Heading tags should be preserved."""
        html = f"<{tag}>Heading</{tag}>"
        result = sanitize_html(html, "https://example.com")
        assert f"<{tag}>" in result

    def test_list_elements_preserved(self):
        """List elements should be preserved."""
        html = "<ul><li>Item 1</li><li>Item 2</li></ul>"
        result = sanitize_html(html, "https://example.com")
        assert "<ul>" in result
        assert "<li>" in result

    def test_table_elements_preserved(self):
        """Table elements should be preserved with allowed attributes."""
        html = '<table><tr><td colspan="2">Cell</td></tr></table>'
        result = sanitize_html(html, "https://example.com")
        assert "<table>" in result
        assert "<tr>" in result
        assert "<td" in result
        assert 'colspan="2"' in result


class TestEmptyAndMalformed:
    """Tests for edge cases."""

    def test_empty_html(self):
        """Empty HTML should return empty string."""
        assert sanitize_html("", "https://example.com") == ""
        assert sanitize_html("   ", "https://example.com") == ""

    def test_whitespace_only(self):
        """Whitespace-only HTML should return empty string."""
        assert sanitize_html("   \n\t  ", "https://example.com") == ""

    def test_malformed_html_handled(self):
        """Malformed HTML should be handled gracefully."""
        html = "<p>Unclosed paragraph<div>Mixed</p></div>"
        # Should not raise
        result = sanitize_html(html, "https://example.com")
        assert "Unclosed paragraph" in result
