"""Test image fixtures for image proxy tests.

Provides minimal valid image byte sequences for testing Pillow decoding
and the image proxy service.

The images are generated programmatically using Pillow to ensure they're
always valid and can be decoded correctly.
"""

import io


def _create_png() -> bytes:
    """Create a minimal valid 1x1 white PNG."""
    from PIL import Image

    img = Image.new("RGB", (1, 1), color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def _create_jpeg() -> bytes:
    """Create a minimal valid 1x1 white JPEG."""
    from PIL import Image

    img = Image.new("RGB", (1, 1), color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG")
    return buffer.getvalue()


def _create_gif() -> bytes:
    """Create a minimal valid 1x1 white GIF."""
    from PIL import Image

    img = Image.new("RGB", (1, 1), color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="GIF")
    return buffer.getvalue()


# Create the image fixtures lazily to avoid import-time Pillow dependency issues
# Use function calls to generate them once
TINY_PNG = _create_png()
TINY_JPEG = _create_jpeg()
TINY_GIF = _create_gif()

# SVG content (should be rejected)
SVG_CONTENT = b'<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>'

# SVG with XML declaration
SVG_WITH_XML = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>'

# HTML content (should be rejected)
HTML_CONTENT = b"<!DOCTYPE html><html><body>Not an image</body></html>"

# Plain text (should be rejected)
TEXT_CONTENT = b"This is plain text, not an image."
