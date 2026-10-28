"""Semantic authored liveness for every server reader of graph projections.

Pages, notes and highlights are projections of canonical ``authored_*`` state and
persist while deleted; ``authored_visible`` is the merged verdict. An authored link's
projection carries its own verdict, endpoint liveness included. A machine fact
(citation, embed, chat context, discovery, assistant) has no liveness of its own: it
is live exactly while each authored endpoint is, so revival reveals it again. A
passage is an independently retained literal quote with no liveness of its own: it
outlives its source note or media and grants no access to either. Nothing physically
deletes an authored row; readers compose these predicates instead.
"""

# Origins of authored link projections: seeded attachments keep theirs; new links are user.
AUTHORED_LINK_ORIGINS = ("user", "highlight_note", "link_note")


def authored_link_sql(alias: str) -> str:
    """SQL boolean: the ``resource_edges`` row ``alias`` projects an authored link."""
    return f"{alias}.origin IN ('user', 'highlight_note', 'link_note')"


def ref_live_sql(scheme: str, ident: str) -> str:
    """SQL boolean over checked-in column expressions: the endpoint is not a hidden or
    absent authored resource or passage. Every other scheme answers true; its own reader
    still owns access."""
    return f"""(CASE {scheme}
        WHEN 'note_block' THEN EXISTS (SELECT 1 FROM note_blocks live_n
            WHERE live_n.id = {ident} AND live_n.authored_visible)
        WHEN 'page' THEN EXISTS (SELECT 1 FROM pages live_p
            WHERE live_p.id = {ident} AND live_p.authored_visible)
        WHEN 'highlight' THEN EXISTS (SELECT 1 FROM highlights live_h
            WHERE live_h.id = {ident} AND live_h.authored_visible)
        WHEN 'passage_anchor' THEN EXISTS (SELECT 1 FROM passage_anchors live_pa
            WHERE live_pa.id = {ident})
        ELSE TRUE END)"""


def edge_live_sql(alias: str) -> str:
    """SQL boolean: the ``resource_edges`` row ``alias`` is live, with both endpoints."""
    return f"""({alias}.authored_visible
        AND {ref_live_sql(f"{alias}.source_scheme", f"{alias}.source_id")}
        AND {ref_live_sql(f"{alias}.target_scheme", f"{alias}.target_id")})"""
