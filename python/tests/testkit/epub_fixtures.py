"""EPUB corpus and source-stream doubles shared by bounded extraction proofs.

The extraction planner reads its source as a byte stream and reserves through a
session factory, so every proof of a real book needs both a packaged archive and
those two seams. These builders own only that plumbing; the markup each scenario
is about stays in the scenario.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator

EPUB2_NCX = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN"
  "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="legacy-proof"/></head>
  <docTitle><text>Legacy proof</text></docTitle>
  <navMap><navPoint id="navpoint-1" playOrder="1">
    <navLabel><text>Chapter&nbsp;One</text></navLabel>
    <content src="chapter.xhtml"/>
  </navPoint></navMap>
</ncx>
"""


class ChunkedSourceStorage:
    """Serve one source object as a stream, never as a single accumulated buffer."""

    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def stream_object(self, _storage_path: str) -> Iterator[bytes]:
        midpoint = len(self.payload) // 2
        yield self.payload[:midpoint]
        yield self.payload[midpoint:]


class ReservationSession:
    """Stand in for the reservation session an extraction plan opens and closes."""

    def close(self) -> None:
        pass


def zip_payload(entries: dict[str, bytes]) -> bytes:
    """Pack named entries into one stored-compression archive."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for path, content in entries.items():
            archive.writestr(path, content)
    return output.getvalue()


def epub2_payload(*, chapter: bytes, ncx: bytes) -> bytes:
    """One EPUB 2 package: an NCX table of contents and an XHTML 1.1 spine item."""
    return zip_payload(
        {
            "mimetype": b"application/epub+zip",
            "META-INF/container.xml": b"""<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>
""",
            "OEBPS/content.opf": b"""<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Legacy proof</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter"/></spine>
</package>
""",
            "OEBPS/toc.ncx": ncx,
            "OEBPS/chapter.xhtml": chapter,
        }
    )
