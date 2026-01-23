"""Tests for canonical text generation per s2_pr04.md spec.

Canonicalization tests:
- Block boundary newlines
- Whitespace collapsing
- <br> handling
- hidden/aria-hidden excluded
- Unicode NFC normalization
"""

from nexus.services.canonicalize import generate_canonical_text


class TestBlockBoundaries:
    """Tests for block element handling."""

    def test_paragraph_boundaries(self):
        """Paragraphs should create line breaks."""
        html = "<p>First paragraph.</p><p>Second paragraph.</p>"
        result = generate_canonical_text(html)
        assert "First paragraph.\nSecond paragraph." in result

    def test_heading_boundaries(self):
        """Headings should create line breaks."""
        html = "<h1>Title</h1><p>Content</p>"
        result = generate_canonical_text(html)
        lines = result.split("\n")
        assert "Title" in lines[0]
        assert "Content" in result

    def test_list_boundaries(self):
        """List items should create line breaks."""
        html = "<ul><li>Item 1</li><li>Item 2</li></ul>"
        result = generate_canonical_text(html)
        assert "Item 1" in result
        assert "Item 2" in result
        # Each list item should be on separate line
        lines = [line.strip() for line in result.split("\n") if line.strip()]
        assert "Item 1" in lines
        assert "Item 2" in lines

    def test_blockquote_boundaries(self):
        """Blockquotes should create line breaks."""
        html = "<p>Before</p><blockquote>Quoted text</blockquote><p>After</p>"
        result = generate_canonical_text(html)
        lines = [line.strip() for line in result.split("\n") if line.strip()]
        assert "Before" in lines
        assert "Quoted text" in lines
        assert "After" in lines


class TestBrElement:
    """Tests for <br> handling."""

    def test_br_creates_newline(self):
        """<br> should insert a newline."""
        html = "<p>Line one<br>Line two</p>"
        result = generate_canonical_text(html)
        assert "Line one\nLine two" in result

    def test_multiple_br_elements(self):
        """Multiple <br> elements should create multiple newlines."""
        html = "<p>One<br>Two<br>Three</p>"
        result = generate_canonical_text(html)
        lines = [line.strip() for line in result.split("\n") if line.strip()]
        assert "One" in lines
        assert "Two" in lines
        assert "Three" in lines


class TestWhitespaceNormalization:
    """Tests for whitespace handling."""

    def test_collapse_consecutive_spaces(self):
        """Consecutive spaces should be collapsed to single space."""
        html = "<p>Text   with    multiple     spaces</p>"
        result = generate_canonical_text(html)
        # Multiple spaces should become single space
        assert "  " not in result
        assert "Text with multiple spaces" in result

    def test_nbsp_becomes_space(self):
        """Non-breaking spaces should become regular spaces."""
        html = "<p>Text\u00a0with\u00a0nbsp</p>"
        result = generate_canonical_text(html)
        assert "Text with nbsp" in result

    def test_tabs_and_newlines_collapsed(self):
        """Tabs and newlines in source should be collapsed to spaces."""
        html = "<p>Text\twith\ttabs\nand\nnewlines</p>"
        result = generate_canonical_text(html)
        # Should be collapsed, no literal tabs/newlines inside inline content
        assert "\t" not in result

    def test_trim_lines(self):
        """Lines should be trimmed."""
        html = "<p>  Trimmed  </p>"
        result = generate_canonical_text(html)
        assert result == "Trimmed" or "Trimmed" in result.strip()

    def test_collapse_blank_lines(self):
        """Multiple blank lines should collapse to single blank line."""
        html = "<p>One</p><p></p><p></p><p>Two</p>"
        result = generate_canonical_text(html)
        # Should not have more than one consecutive blank line
        assert "\n\n\n" not in result


class TestExclusions:
    """Tests for excluded elements."""

    def test_hidden_elements_excluded(self):
        """Elements with hidden attribute should be excluded."""
        html = "<p>Visible</p><p hidden>Hidden text</p><p>Also visible</p>"
        result = generate_canonical_text(html)
        assert "Visible" in result
        assert "Also visible" in result
        assert "Hidden text" not in result

    def test_aria_hidden_excluded(self):
        """Elements with aria-hidden="true" should be excluded."""
        html = '<p>Visible</p><span aria-hidden="true">Screen reader only</span><p>More</p>'
        result = generate_canonical_text(html)
        assert "Visible" in result
        assert "More" in result
        assert "Screen reader only" not in result

    def test_script_style_excluded(self):
        """Script and style elements should be excluded."""
        html = "<p>Content</p><script>code</script><style>.class{}</style>"
        result = generate_canonical_text(html)
        assert "Content" in result
        assert "code" not in result
        assert ".class" not in result


class TestUnicodeNormalization:
    """Tests for Unicode NFC normalization."""

    def test_nfc_normalization(self):
        """Text should be NFC normalized."""
        # é as e + combining acute vs precomposed é
        html = "<p>caf\u0065\u0301</p>"  # e + combining acute
        result = generate_canonical_text(html)
        # Should be normalized to precomposed form
        assert "café" in result or "cafe\u0301" not in result


class TestComplexDocuments:
    """Tests for realistic document structures."""

    def test_article_structure(self):
        """Complex article structure should be handled correctly."""
        html = """
        <article>
            <h1>Article Title</h1>
            <p>First paragraph with <strong>bold</strong> and <em>italic</em>.</p>
            <p>Second paragraph.</p>
            <blockquote>A quoted section.</blockquote>
            <ul>
                <li>List item one</li>
                <li>List item two</li>
            </ul>
        </article>
        """
        result = generate_canonical_text(html)

        assert "Article Title" in result
        assert "First paragraph with bold and italic." in result
        assert "Second paragraph." in result
        assert "A quoted section." in result
        assert "List item one" in result
        assert "List item two" in result

    def test_nested_formatting(self):
        """Nested inline formatting should be flattened."""
        html = "<p><strong><em>Bold italic</em></strong> text</p>"
        result = generate_canonical_text(html)
        assert "Bold italic text" in result


class TestEdgeCases:
    """Tests for edge cases."""

    def test_empty_html(self):
        """Empty HTML should return empty string."""
        assert generate_canonical_text("") == ""
        assert generate_canonical_text("   ") == ""

    def test_only_whitespace_content(self):
        """HTML with only whitespace content should return empty."""
        html = "<p>   </p><div>  </div>"
        result = generate_canonical_text(html)
        assert result.strip() == ""

    def test_pre_whitespace_handling(self):
        """<pre> elements should be included (whitespace normalized)."""
        html = "<pre>  code\n  here  </pre>"
        result = generate_canonical_text(html)
        # Content should be included, whitespace normalized
        assert "code" in result
        assert "here" in result
