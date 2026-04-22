"""Shared seeded-media constants for Python tests."""

from uuid import UUID

FIXTURE_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")
FIXTURE_FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")

FIXTURE_HTML_SANITIZED = """
<p>This is a <strong>seeded test article</strong> for Slice 0 validation.</p>
<p>It includes <em>inline formatting</em> and a
<a href="https://example.com/test" rel="noopener noreferrer" target="_blank">sample link</a>.</p>
<p>Image placeholder: <img src="https://example.com/placeholder.png" alt="Placeholder" /></p>
""".strip()

FIXTURE_CANONICAL_TEXT = """
This is a seeded test article for Slice 0 validation.
It includes inline formatting and a sample link.
Image placeholder:
""".strip()

FIXTURE_TITLE = "Seeded Test Article"
FIXTURE_SOURCE_URL = "https://example.com/test-article"
