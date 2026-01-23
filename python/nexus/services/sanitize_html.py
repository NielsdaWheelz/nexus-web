"""HTML sanitization for web article content.

Sanitizes HTML from Readability extraction per the constitution and s2_spec:
- Allowlisted tags only
- Allowlisted attributes only
- No event handlers (on*)
- No inline styles
- No javascript:/data: URLs
- Images rewritten to proxy endpoint
- External links get rel/target/referrerpolicy

This module uses lxml for robust HTML parsing and transformation.
"""

import re
from urllib.parse import quote, urljoin, urlparse

from lxml.html import HtmlElement, document_fromstring, tostring

# Allowed tags per s2_spec.md §5.2
ALLOWED_TAGS = frozenset(
    {
        "p",
        "br",
        "strong",
        "em",
        "b",
        "i",
        "u",
        "s",
        "blockquote",
        "pre",
        "code",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "a",
        "img",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "sup",
        "sub",
        # Container elements (allowed but stripped of attributes)
        "div",
        "span",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "aside",
        "figure",
        "figcaption",
    }
)

# Allowed attributes per tag
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt"},
    "th": {"colspan", "rowspan"},
    "td": {"colspan", "rowspan"},
}

# Forbidden URL schemes
FORBIDDEN_SCHEMES = frozenset({"javascript", "vbscript", "data", "file"})

# Regex to detect event handlers
EVENT_HANDLER_RE = re.compile(r"^on", re.IGNORECASE)

# Image proxy URL template
IMAGE_PROXY_URL = "/media/image?url={encoded_url}"


def sanitize_html(html: str, base_url: str) -> str:
    """Sanitize HTML content from web article extraction.

    This function:
    1. Parses HTML into DOM
    2. Resolves relative URLs using base_url
    3. Applies tag/attribute allowlist
    4. Strips all event handlers and styles
    5. Rewrites images to proxy endpoint
    6. Adds security attributes to links

    Args:
        html: The HTML content to sanitize (from Readability).
        base_url: The base URL for resolving relative URLs.

    Returns:
        Sanitized HTML string.

    Raises:
        ValueError: If HTML cannot be parsed.
    """
    if not html or not html.strip():
        return ""

    try:
        # Parse HTML - lxml handles malformed HTML gracefully
        doc = document_fromstring(html)
    except Exception as e:
        raise ValueError(f"Failed to parse HTML: {e}") from e

    # Get body element - this is where content lives
    body = doc.body
    if body is None:
        return ""

    # Process body's children (not body itself, as we need to preserve it for serialization)
    for child in list(body):
        if isinstance(child, HtmlElement):
            _sanitize_element(child, base_url)

    # Serialize back to string
    # Use method='html' to preserve HTML semantics (e.g., self-closing tags)
    result = tostring(body, encoding="unicode", method="html")

    # Remove the wrapper body tag that lxml adds
    if result.startswith("<body>") and result.endswith("</body>"):
        result = result[6:-7]

    return result


def _sanitize_element(element: HtmlElement, base_url: str) -> None:
    """Recursively sanitize an element and its children.

    Modifies the element tree in-place.
    """
    # Process children first (deepest elements first)
    for child in list(element):
        if isinstance(child, HtmlElement):
            _sanitize_element(child, base_url)

    # Check if this element's tag is allowed
    tag = element.tag.lower() if element.tag else ""

    # Handle special cases
    if tag in (
        "script",
        "style",
        "iframe",
        "form",
        "object",
        "embed",
        "svg",
        "meta",
        "link",
        "base",
    ):
        # Remove these elements entirely (including content)
        _remove_element(element)
        return

    if tag not in ALLOWED_TAGS:
        # Unwrap element (keep children, remove tag)
        _unwrap_element(element)
        return

    # Sanitize attributes
    _sanitize_attributes(element, tag, base_url)


def _sanitize_attributes(element: HtmlElement, tag: str, base_url: str) -> None:
    """Sanitize attributes on an element."""
    allowed = ALLOWED_ATTRS.get(tag, set())

    # Get all attributes and filter
    attrs_to_remove = []
    for attr in element.attrib:
        attr_lower = attr.lower()

        # Always remove event handlers
        if EVENT_HANDLER_RE.match(attr_lower):
            attrs_to_remove.append(attr)
            continue

        # Always remove style, class, id
        if attr_lower in ("style", "class", "id"):
            attrs_to_remove.append(attr)
            continue

        # Remove disallowed attributes
        if attr_lower not in allowed:
            attrs_to_remove.append(attr)
            continue

    # Remove collected attributes
    for attr in attrs_to_remove:
        del element.attrib[attr]

    # Special handling for specific tags
    if tag == "a":
        _sanitize_link(element, base_url)
    elif tag == "img":
        _sanitize_image(element, base_url)


def _sanitize_link(element: HtmlElement, base_url: str) -> None:
    """Sanitize an anchor element."""
    href = element.get("href", "")

    if not href:
        return

    # Resolve relative URLs
    absolute_url = urljoin(base_url, href)

    # Check scheme
    parsed = urlparse(absolute_url)
    scheme = parsed.scheme.lower()

    if scheme in FORBIDDEN_SCHEMES:
        # Remove href for forbidden schemes
        del element.attrib["href"]
        return

    # Update href to absolute URL
    element.set("href", absolute_url)

    # Add security attributes (merge with existing rel if present)
    existing_rel = element.get("rel", "")
    rel_values = set(existing_rel.split()) if existing_rel else set()
    rel_values.add("noopener")
    rel_values.add("noreferrer")
    element.set("rel", " ".join(sorted(rel_values)))

    element.set("target", "_blank")
    element.set("referrerpolicy", "no-referrer")


def _sanitize_image(element: HtmlElement, base_url: str) -> None:
    """Sanitize an image element by routing through proxy."""
    src = element.get("src", "")

    if not src:
        return

    # Resolve relative URL
    absolute_url = urljoin(base_url, src)

    # Check scheme
    parsed = urlparse(absolute_url)
    scheme = parsed.scheme.lower()

    if scheme in FORBIDDEN_SCHEMES:
        # Remove src for forbidden schemes
        del element.attrib["src"]
        return

    # Only allow http/https
    if scheme not in ("http", "https"):
        del element.attrib["src"]
        return

    # Rewrite to image proxy
    encoded_url = quote(absolute_url, safe="")
    proxy_url = IMAGE_PROXY_URL.format(encoded_url=encoded_url)
    element.set("src", proxy_url)


def _remove_element(element: HtmlElement) -> None:
    """Remove an element entirely from the tree."""
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _unwrap_element(element: HtmlElement) -> None:
    """Remove element tag but keep its children and text."""
    parent = element.getparent()
    if parent is None:
        return

    # Get index of element in parent
    index = list(parent).index(element)

    # Preserve tail text (text after closing tag)
    tail = element.tail or ""

    # Move children before this element
    for i, child in enumerate(element):
        parent.insert(index + i, child)

    # Handle text content
    text = element.text or ""
    if index > 0:
        # Append to previous sibling's tail
        prev = parent[index - 1] if index > 0 else None
        if prev is not None:
            prev.tail = (prev.tail or "") + text
        else:
            parent.text = (parent.text or "") + text
    else:
        # Prepend to parent's text
        parent.text = (parent.text or "") + text

    # Append tail to last child or previous sibling
    if len(element) > 0:
        last_child = element[-1]
        last_child.tail = (last_child.tail or "") + tail
    elif index > 0:
        prev = parent[index - 1 + len(element)]
        prev.tail = (prev.tail or "") + tail
    else:
        parent.text = (parent.text or "") + tail

    # Remove the element
    parent.remove(element)
