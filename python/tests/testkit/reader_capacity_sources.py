"""Deterministic real sources for the existing publication capacity experiments."""

import hashlib

import fitz

from tests.testkit.epub_fixtures import zip_payload


def epub_capacity_source(*, rendered_bytes: int, dense_words: bool = False) -> tuple[bytes, dict]:
    """Four spine items; count sanitized HTML plus canonical UTF-8 separately."""
    # Four retained <p>...</p> pairs contribute 28 bytes. ASCII text is counted
    # once in each representation. This recipe has no discarded authored text.
    if rendered_bytes < 1024 or rendered_bytes % 2:
        raise ValueError("The four-chapter recipe needs an even rendered budget >= 1024")
    lengths = divmod((rendered_bytes - 28) // 2, 4)
    entries = {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": (
            b'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            b'<rootfiles><rootfile full-path="EPUB/package.opf" '
            b'media-type="application/oebps-package+xml"/></rootfiles></container>'
        ),
        "EPUB/package.opf": (
            '<package version="3.0" xmlns="http://www.idpf.org/2007/opf">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>Publication capacity</dc:title><dc:language>en</dc:language></metadata>"
            "<manifest>"
            + "".join(
                f'<item id="chapter-{index}" href="chapter-{index}.xhtml" '
                'media-type="application/xhtml+xml"/>'
                for index in range(4)
            )
            + "</manifest><spine>"
            + "".join(f'<itemref idref="chapter-{index}"/>' for index in range(4))
            + "</spine></package>"
        ).encode(),
    }
    chapters = []
    for index in range(4):
        length = lengths[0] + (index < lengths[1])
        prefix, suffix = f"chapter-{index}-start ", f" chapter-{index}-end"
        filler_length = length - len(prefix) - len(suffix)
        if dense_words:
            # End in a letter too: adjoining prefix/suffix separators stay single,
            # so this shape preserves the same canonical and sanitized byte budget.
            filler = "a " * ((filler_length - 1) // 2) + "a" * (2 - filler_length % 2)
            filler_words = (filler_length + 1) // 2
        else:
            filler = "a" * filler_length
            filler_words = 1
        text = prefix + filler + suffix
        canonical = text.encode()
        chapter = (
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capacity</title></head>'
            "<body><p>" + text + "</p></body></html>"
        ).encode()
        if len(chapter) > 16 * 1024 * 1024:
            raise ValueError("Recipe exceeds the supported XHTML entry envelope")
        entries[f"EPUB/chapter-{index}.xhtml"] = chapter
        chapters.append(
            {
                "href_path": f"EPUB/chapter-{index}.xhtml",
                "canonical_bytes": len(canonical),
                "sanitized_html_bytes": len(canonical) + 7,
                "canonical_sha256": hashlib.sha256(canonical).hexdigest(),
                "raw_xhtml_bytes": len(chapter),
                "filler_start_cp": len(prefix),
                "filler_end_cp": len(prefix) + filler_length,
                "filler_word_count": filler_words,
                # Each fixed prefix/suffix has six ASCII word/space/punctuation
                # segments. The filler has 2*words-1; source start adds one point.
                "word_boundary_count": 2 * filler_words + 12,
                "first_quote": prefix.rstrip(),
                "last_quote": suffix.lstrip(),
            }
        )
    body = zip_payload(entries)
    return body, {
        "scope": (
            "four ASCII spine items with dense short words and single spaces at the "
            "HTML-plus-canonical byte boundary; not dense DOM, image or CJK qualification"
            if dense_words
            else "four ASCII spine items with long unbroken words at the "
            "HTML-plus-canonical byte boundary; not dense word, DOM, image or CJK qualification"
        ),
        "dense_words": dense_words,
        "source_bytes": len(body),
        "source_sha256": hashlib.sha256(body).hexdigest(),
        "rendered_bytes": rendered_bytes,
        "canonical_bytes": sum(chapter["canonical_bytes"] for chapter in chapters),
        "chapters": chapters,
    }


def pdf_capacity_source(
    *, page_count: int, text_bytes: int, source_bytes: int | None = None
) -> tuple[bytes, dict]:
    """Real visible Courier text; optional legal stream comments charge transfer."""
    if not 1 <= page_count <= 10_000 or text_bytes < page_count * 128:
        raise ValueError("Recipe needs supported pages and at least 128 text bytes per page")
    # The extraction owner joins nonempty pages with two newlines.
    base, extra = divmod(text_bytes - 2 * (page_count - 1), page_count)
    digest = hashlib.sha256()
    lengths = []
    with fitz.open() as document:
        for index in range(page_count):
            length = base + (index < extra)
            lines = (length + 81) // 81
            if lines > 60:
                raise ValueError("Recipe text does not fit the fixed visible page geometry")
            chars = length - lines + 1
            prefix, suffix = f"page-{index:05d}-start ", f" page-{index:05d}-end"
            raw = prefix + "a" * (chars - len(prefix) - len(suffix)) + suffix
            width, longer = divmod(chars, lines)
            chunks, position = [], 0
            for line in range(lines):
                end = position + width + (line < longer)
                chunks.append(raw[position:end])
                position = end
            text = "\n".join(chunks)
            if index:
                digest.update(b"\n\n")
            digest.update(text.encode())
            lengths.append(len(text))
            page = document.new_page(width=612, height=792)
            page.insert_text((36, 36), text, fontname="cour", fontsize=8)
        body = document.tobytes(deflate=False, no_new_id=True)
        if source_bytes is not None:
            padding = source_bytes - len(body) - 3
            if padding < 0:
                raise ValueError("Encoded PDF already exceeds the requested source size")
            stream = document[-1].get_contents()[-1]
            original = document.xref_stream(stream)
            document.update_stream(
                stream, original + b"\n%" + b"x" * padding + b"\n", compress=False
            )
            body = document.tobytes(deflate=False, no_new_id=True)
            # Stream Length and startxref decimal widths can grow after padding.
            padding += source_bytes - len(body)
            document.update_stream(
                stream, original + b"\n%" + b"x" * padding + b"\n", compress=False
            )
            body = document.tobytes(deflate=False, no_new_id=True)
            if len(body) != source_bytes:
                raise AssertionError("PDF byte recipe changed beyond its decimal-width correction")
    return body, {
        "scope": "real visible text and page count; comment padding qualifies encoded bytes, not dense images or operators",
        "source_bytes": len(body),
        "source_sha256": hashlib.sha256(body).hexdigest(),
        "page_count": page_count,
        "text_bytes": text_bytes,
        "text_sha256": digest.hexdigest(),
        "page_text_bytes": lengths,
        "first_quote": "page-00000-start",
        "last_quote": f"page-{page_count - 1:05d}-end",
    }
