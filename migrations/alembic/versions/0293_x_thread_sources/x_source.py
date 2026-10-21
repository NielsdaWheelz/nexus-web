# Frozen for migration 0293 from d6f04890c:python/nexus/services/x_source.py (its labels).
"""Read canonical X bodies, proved membership and current capture facts.

Relational columns own identity, lineage and availability; payload owns authored
content. Reads reconstruct that one contract. No aggregate body or legacy reader
exists. Callers needing several related reads own the database snapshot.
"""

from __future__ import annotations

from collections.abc import Sequence

import regex

from .schemas import XSourcePost, XSourceScope


def post_label(post: XSourcePost) -> str:
    return source_label((post,), scope="post")


def source_label(posts: Sequence[XSourcePost], *, scope: XSourceScope) -> str:
    """An authored opening, at most 120 code points without splitting graphemes."""
    if not posts:
        raise ValueError("source label requires a primary post")
    for post in posts:
        value = " ".join(post.content.text.split())
        if not value:
            continue
        if len(value) <= 120:
            return value
        grapheme_ends = {
            match.end() for match in regex.finditer(r"\X", value) if match.end() <= 119
        }
        if not grapheme_ends:
            break
        end = max(grapheme_ends)
        boundaries = [
            match.start()
            for match in regex.finditer(r"\b", value, regex.WORD)
            if match.start() in grapheme_ends
        ]
        boundary = max(boundaries, default=0)
        if boundary and regex.fullmatch(r"(?:[@#]\S*\s*)+", value[:boundary]):
            boundary = 0
        return value[: boundary or end].rstrip() + "…"
    kind = "thread" if scope == "author_thread" else "post"
    return f"x {kind} by @{posts[0].content.author.username}"
