"""Batched per-ref connection summaries for the collection surface (spec S4).

Lists radiate what the substrate already knows, deterministically and AI-free:
each row carries a ``↳ N connected`` count, a per-kind breakdown, and a short
rail of its most-recent distinct peers. One batched ``GROUP BY`` over
``resource_edges`` produces every ref's counts (mirroring ``concordant_sources``);
the peers are hydrated through the same ``resolve_refs`` + ``resource_activation_for_ref``
helpers ``query_connections`` uses, so deleted/forbidden peers come back
``missing=True`` and are never leaked.

``LIST_CONNECTION_ORIGINS`` is intentionally narrower than
``READER_CONNECTION_ORIGINS`` (``services/reader_connections.py``): it excludes
``synapse`` (AI) and ``system`` (plumbing). The collection surface is AI-free in
v1.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    ConnectionEndpoint,
    EdgeKind,
    EdgeOrigin,
)
from nexus.services.resource_items.routing import resource_activation_for_ref

# Default-deny allowlist for the collection surface (spec S4). Declared like
# ``READER_CONNECTION_ORIGINS`` but INTENTIONALLY NARROWER: ``synapse`` (AI) and
# ``system`` (plumbing) are excluded so lists stay deterministic and AI-free.
LIST_CONNECTION_ORIGINS: tuple[EdgeOrigin, ...] = (
    "user",
    "citation",
    "note_body",
    "highlight_note",
    "document_embed",
)

# Deterministic tie-break for ``dominant_kind``: a kind with the most edges wins,
# ties broken by this fixed precedence (the edge-vocabulary declaration order).
_KIND_ORDER: dict[EdgeKind, int] = {"context": 0, "supports": 1, "contradicts": 2}


@dataclass(frozen=True, slots=True)
class ConnectionSummary:
    """One ref's connection aggregate: counts plus a short hydrated peer rail."""

    ref: ResourceRef
    total: int
    by_kind: dict[EdgeKind, int]
    last_connected_at: datetime | None
    dominant_kind: EdgeKind | None
    top_peers: tuple[ConnectionEndpoint, ...]


def summarize_connections(
    db: Session,
    *,
    viewer_id: UUID,
    refs: tuple[ResourceRef, ...],
    origins: tuple[EdgeOrigin, ...] = LIST_CONNECTION_ORIGINS,
    peers_per_ref: int = 5,
) -> list[ConnectionSummary]:
    """Summarize each ref's connections in one batched GROUP BY + one resolve.

    For each ref, ``resource_edges`` are counted where the ref is the source OR
    the target (both directions), ``origin = ANY(origins)``, grouped by ``kind``.
    Edges are already viewer-scoped (``resource_edges.user_id = viewer_id``).
    ``top_peers`` are the most-recent distinct peer endpoints (the "other" side),
    up to ``peers_per_ref``, hydrated through the shared resolve/activation helpers.
    The result is one summary per input ref, in input order; duplicate refs share
    one computed summary.
    """
    unique: dict[str, ResourceRef] = {}
    for ref in refs:
        unique.setdefault(ref.uri, ref)
    if not unique or not origins:
        return [_empty_summary(ref) for ref in refs]

    counts = _count_by_kind(db, viewer_id=viewer_id, refs=unique, origins=origins)
    peers = _top_peers(
        db,
        viewer_id=viewer_id,
        refs=unique,
        origins=origins,
        peers_per_ref=peers_per_ref,
    )
    empty_counts: dict[EdgeKind, tuple[int, datetime]] = {}
    by_uri = {
        uri: _summary_for_ref(
            ref, kind_counts=counts.get(uri, empty_counts), peers=peers.get(uri, ())
        )
        for uri, ref in unique.items()
    }
    return [by_uri[ref.uri] for ref in refs]


def _empty_summary(ref: ResourceRef) -> ConnectionSummary:
    return ConnectionSummary(
        ref=ref,
        total=0,
        by_kind={},
        last_connected_at=None,
        dominant_kind=None,
        top_peers=(),
    )


def _summary_for_ref(
    ref: ResourceRef,
    *,
    kind_counts: dict[EdgeKind, tuple[int, datetime]],
    peers: tuple[ConnectionEndpoint, ...],
) -> ConnectionSummary:
    if not kind_counts:
        return ConnectionSummary(
            ref=ref,
            total=0,
            by_kind={},
            last_connected_at=None,
            dominant_kind=None,
            top_peers=peers,
        )
    by_kind: dict[EdgeKind, int] = {kind: count for kind, (count, _last) in kind_counts.items()}
    total = sum(by_kind.values())
    last_connected_at = max(last for _count, last in kind_counts.values())
    # Highest count wins; ties broken deterministically by the edge-vocabulary order.
    dominant_kind: EdgeKind = min(
        by_kind, key=lambda kind: (-by_kind[kind], _KIND_ORDER.get(kind, len(_KIND_ORDER)))
    )
    return ConnectionSummary(
        ref=ref,
        total=total,
        by_kind=by_kind,
        last_connected_at=last_connected_at,
        dominant_kind=dominant_kind,
        top_peers=peers,
    )


def _ref_values_rows(refs: dict[str, ResourceRef]) -> tuple[str, dict[str, object]]:
    """Build a ``VALUES`` row set ``(ord, scheme, id)`` and its bound params.

    Refs travel as a literal ``VALUES`` list (one row per distinct ref), keyed by
    an ordinal so the result joins back to the input set unambiguously.
    """
    rows: list[str] = []
    params: dict[str, object] = {}
    for index, ref in enumerate(refs.values()):
        rows.append(f"(:scheme_{index}, CAST(:id_{index} AS uuid))")
        params[f"scheme_{index}"] = ref.scheme
        params[f"id_{index}"] = str(ref.id)
    return ", ".join(rows), params


def _count_by_kind(
    db: Session,
    *,
    viewer_id: UUID,
    refs: dict[str, ResourceRef],
    origins: tuple[EdgeOrigin, ...],
) -> dict[str, dict[EdgeKind, tuple[int, datetime]]]:
    """One batched GROUP BY: per (ref, kind) edge count + MAX(created_at).

    Each input ref contributes the edges on which it is the source OR the target
    (the ``UNION ALL`` of the two directions inside ``ref_edges``); a self-loop
    edge (source == target == ref) is counted once per side by design — the same
    "either endpoint" semantics ``query_connections`` uses.
    """
    values_sql, params = _ref_values_rows(refs)
    params["viewer_id"] = viewer_id
    params["origins"] = list(origins)
    rows = db.execute(
        text(
            f"""
            WITH refs(scheme, id) AS (VALUES {values_sql}),
            ref_edges AS (
                SELECT r.scheme AS ref_scheme, r.id AS ref_id, e.kind, e.created_at
                FROM refs r
                JOIN resource_edges e
                  ON e.user_id = :viewer_id
                 AND e.origin = ANY(:origins)
                 AND e.source_scheme = r.scheme
                 AND e.source_id = r.id
                UNION ALL
                SELECT r.scheme AS ref_scheme, r.id AS ref_id, e.kind, e.created_at
                FROM refs r
                JOIN resource_edges e
                  ON e.user_id = :viewer_id
                 AND e.origin = ANY(:origins)
                 AND e.target_scheme = r.scheme
                 AND e.target_id = r.id
            )
            SELECT ref_scheme, ref_id, kind,
                   COUNT(*) AS edge_count,
                   MAX(created_at) AS last_created_at
            FROM ref_edges
            GROUP BY ref_scheme, ref_id, kind
            """
        ),
        params,
    ).fetchall()
    out: dict[str, dict[EdgeKind, tuple[int, datetime]]] = defaultdict(dict)
    for ref_scheme, ref_id, kind, edge_count, last_created_at in rows:
        uri = f"{ref_scheme}:{ref_id}"
        # ck_resource_edges_kind guarantees ``kind`` is a valid EdgeKind value.
        out[uri][cast("EdgeKind", kind)] = (int(edge_count), last_created_at)
    return out


def _top_peers(
    db: Session,
    *,
    viewer_id: UUID,
    refs: dict[str, ResourceRef],
    origins: tuple[EdgeOrigin, ...],
    peers_per_ref: int,
) -> dict[str, tuple[ConnectionEndpoint, ...]]:
    """Most-recent distinct peer endpoints per ref, hydrated once across all refs.

    The peer is the "other" side of each edge. Peers are de-duplicated per ref
    (a ref connected to the same peer by several edges shows that peer once,
    at its most-recent edge) and capped at ``peers_per_ref`` via a windowed
    ``ROW_NUMBER``. Hydration goes through the SAME ``resolve_refs`` +
    ``resource_activation_for_ref`` helpers ``query_connections`` uses, batched in
    one resolve over every ref's peers, so each peer carries ``label``/``href`` and
    deleted/forbidden peers come back ``missing=True``.
    """
    if peers_per_ref < 1:
        return {}
    peer_uris = _ranked_peer_uris(
        db, viewer_id=viewer_id, refs=refs, origins=origins, peers_per_ref=peers_per_ref
    )
    endpoints = _hydrate_peer_endpoints(db, viewer_id=viewer_id, peer_uris=peer_uris)
    out: dict[str, tuple[ConnectionEndpoint, ...]] = {}
    for uri, ordered_peers in peer_uris.items():
        out[uri] = tuple(endpoints[peer_uri] for peer_uri in ordered_peers)
    return out


def _ranked_peer_uris(
    db: Session,
    *,
    viewer_id: UUID,
    refs: dict[str, ResourceRef],
    origins: tuple[EdgeOrigin, ...],
    peers_per_ref: int,
) -> dict[str, list[str]]:
    values_sql, params = _ref_values_rows(refs)
    params["viewer_id"] = viewer_id
    params["origins"] = list(origins)
    params["peers_per_ref"] = peers_per_ref
    rows = db.execute(
        text(
            f"""
            WITH refs(scheme, id) AS (VALUES {values_sql}),
            ref_peers AS (
                SELECT r.scheme AS ref_scheme, r.id AS ref_id,
                       e.target_scheme AS peer_scheme, e.target_id AS peer_id,
                       e.created_at
                FROM refs r
                JOIN resource_edges e
                  ON e.user_id = :viewer_id
                 AND e.origin = ANY(:origins)
                 AND e.source_scheme = r.scheme
                 AND e.source_id = r.id
                UNION ALL
                SELECT r.scheme AS ref_scheme, r.id AS ref_id,
                       e.source_scheme AS peer_scheme, e.source_id AS peer_id,
                       e.created_at
                FROM refs r
                JOIN resource_edges e
                  ON e.user_id = :viewer_id
                 AND e.origin = ANY(:origins)
                 AND e.target_scheme = r.scheme
                 AND e.target_id = r.id
            ),
            distinct_peers AS (
                SELECT ref_scheme, ref_id, peer_scheme, peer_id,
                       MAX(created_at) AS last_created_at
                FROM ref_peers
                GROUP BY ref_scheme, ref_id, peer_scheme, peer_id
            ),
            ranked AS (
                SELECT ref_scheme, ref_id, peer_scheme, peer_id, last_created_at,
                       ROW_NUMBER() OVER (
                           PARTITION BY ref_scheme, ref_id
                           ORDER BY last_created_at DESC, peer_scheme ASC, peer_id ASC
                       ) AS rank
                FROM distinct_peers
            )
            SELECT ref_scheme, ref_id, peer_scheme, peer_id
            FROM ranked
            WHERE rank <= :peers_per_ref
            ORDER BY ref_scheme, ref_id, last_created_at DESC, peer_scheme ASC, peer_id ASC
            """
        ),
        params,
    ).fetchall()
    out: dict[str, list[str]] = defaultdict(list)
    for ref_scheme, ref_id, peer_scheme, peer_id in rows:
        out[f"{ref_scheme}:{ref_id}"].append(f"{peer_scheme}:{peer_id}")
    return out


def _hydrate_peer_endpoints(
    db: Session, *, viewer_id: UUID, peer_uris: dict[str, list[str]]
) -> dict[str, ConnectionEndpoint]:
    """Resolve every ref's peers in one batch (mirrors ``_hydrate_endpoints``)."""
    distinct: dict[str, ResourceRef] = {}
    for ordered_peers in peer_uris.values():
        for peer_uri in ordered_peers:
            if peer_uri not in distinct:
                scheme, _sep, ident = peer_uri.partition(":")
                distinct[peer_uri] = ResourceRef(scheme=_assert_scheme(scheme), id=UUID(ident))
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=list(distinct.values()))
    endpoints: dict[str, ConnectionEndpoint] = {}
    for ref, item in zip(distinct.values(), resolved, strict=True):
        activation = resource_activation_for_ref(
            db, viewer_id=viewer_id, ref=ref, missing=item.missing
        )
        endpoints[ref.uri] = ConnectionEndpoint(
            ref=ref,
            label=item.label,
            description=item.summary or None,
            activation=activation,
            href=activation.href,
            missing=item.missing,
        )
    return endpoints


def _assert_scheme(scheme: str) -> ResourceScheme:
    if scheme not in RESOURCE_SCHEMES:
        # justify-defect: peer schemes are persisted ``resource_edges`` columns
        # gated by ck_resource_edges_*_scheme; an unknown value is corrupt data.
        raise AssertionError(f"unknown peer scheme {scheme!r}")
    return cast("ResourceScheme", scheme)
