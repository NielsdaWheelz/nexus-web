// Direct reader roots: identity, facets and canonical source context. Disclosures
// alone read descendants; none of these helpers infer membership from children.
import type { Schema } from "@/lib/api/wire";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import type { ReaderDocument, ReaderPoint } from "@/lib/documentReader/model";
import { resourceOccurrenceKey } from "@/lib/notes/outline";
import type { OutlineDestination, PendingOccurrence } from "@/lib/notes/useOutlineSession";
import { targetOfResolution } from "../hostedReader";

export type EvidenceRoot = Schema<"ReaderEvidenceRootOut"> & {
  readonly source: {
    readonly media_id: string;
    readonly identity: string;
    readonly apparatus_source: Schema<"SourceAttributionOut"> | null;
  };
};
const ROOT_PREFIX = "evidence";
export const rootKey = (root: EvidenceRoot) => resourceOccurrenceKey(ROOT_PREFIX, root.ref);
export const pendingRootKey = (item: PendingOccurrence) => resourceOccurrenceKey(ROOT_PREFIX, item.ref);

export function rootContinuation(root: EvidenceRoot): OutlineDestination | null {
  const continuation = root.continuation;
  if (continuation === null) return null;
  return { source: continuation.source, position: continuation.position,
    occurrencePrefix: continuation.kind === "sibling" ? ROOT_PREFIX : rootKey(root), path: [],
    ...(continuation.kind === "sibling" ? { rootOccurrencePrefix: ROOT_PREFIX } : {}),
  };
}

export function pendingContinuation(item: PendingOccurrence): OutlineDestination {
  return { source: { kind: "resource", ref: item.sourceRef },
    position: item.position === null ? null : { ...item.position, after: item.edgeId },
    occurrencePrefix: ROOT_PREFIX, rootOccurrencePrefix: ROOT_PREFIX, path: [],
  };
}

export type Filter = keyof Schema<"ReaderEvidenceCountsOut">;
export const FILTERS: readonly Filter[] = ["highlights", "citations", "links", "machine_links"];
export const FILTER_LABELS: Record<Filter, string> = {
  highlights: "highlights", citations: "citations", links: "links", machine_links: "librarian links",
};

export function factFacet(fact: Schema<"ReaderDirectFactOut">): Filter {
  if (fact.origin === "citation" && fact.ordinal !== null) return "citations";
  return fact.origin === "assistant" || fact.origin === "discovery" ? "machine_links" : "links";
}

export function facets(root: EvidenceRoot): ReadonlySet<Filter> {
  const result = new Set(root.direct_facts.map(factFacet));
  if (root.content.kind === "Highlight") result.add("highlights");
  if (root.content.kind === "SourceReference") result.add("citations");
  return result;
}

export function markerFacet(root: EvidenceRoot): Filter {
  if (root.content.kind === "Highlight") return "highlights";
  if (root.content.kind === "SourceReference") return "citations";
  const own = facets(root);
  return own.has("citations") ? "citations" : own.has("links") ? "links" : "machine_links";
}

export function matches(root: EvidenceRoot, id: string): boolean {
  return root.ref === id || root.direct_facts.some((fact) => fact.edge_id === id)
    || root.content.kind === "Highlight" && root.content.highlight_id === id
    || root.content.kind === "SourceReference" && (root.content.stable_key === id || root.content.marker_anchor_id === id);
}

export function revealFacet(root: EvidenceRoot, id: string, hidden: ReadonlySet<Filter>): Filter {
  const fact = root.direct_facts.find((fact) => fact.edge_id === id);
  if (fact) return factFacet(fact);
  if (root.content.kind === "Highlight" && root.content.highlight_id === id) return "highlights";
  if (root.content.kind === "SourceReference" && (root.content.stable_key === id || root.content.marker_anchor_id === id)) return "citations";
  return FILTERS.find((facet) => facets(root).has(facet) && !hidden.has(facet)) ?? markerFacet(root);
}

export function rootItem(root: EvidenceRoot): Schema<"ResourceItemOut"> {
  const content = root.content;
  if (content.kind !== "SourceReference") return content.item;
  return {
    ref: root.ref, action_ref: content.action_ref, label: content.label,
    preview: {
      body: { kind: "passage", prefix: null, exact: content.excerpt, suffix: null, color: null },
      source: root.source.apparatus_source === null ? null : { ...root.source.apparatus_source, location_label: content.location_label },
      annotation: null,
    },
    activation: content.activation, missing: false,
  };
}

export function rootCounts(roots: readonly EvidenceRoot[]): Schema<"ReaderEvidenceCountsOut"> {
  const counts = { highlights: 0, citations: 0, links: 0, machine_links: 0 };
  for (const root of roots) for (const facet of facets(root)) counts[facet]++;
  return counts;
}

/** One own extent for rail and alignment; time ranges use intersecting units only. */
export function rootExtent(resolution: EvidenceRoot["resolution"], doc: ReaderDocument): {
  start: ReaderPoint; end: ReaderPoint; anchor: MarkAnchor;
} | null {
  if (!resolution) return null;
  const target = targetOfResolution(resolution,doc);
  if (!target) return null;
  if (target.kind === "range") return {
    start: { kind: "text", unit: target.unit, offset: target.start },
    end: { kind: "text", unit: target.unit, offset: target.end },
    anchor: { kind: "text", unit: target.unit, start: target.start, end: target.end },
  };
  if (target.kind === "quads") {
    const ys = target.quads.flatMap((quad) => [quad.y1, quad.y2, quad.y3, quad.y4]);
    return { start: { kind: "pdf", page: target.page, y: Math.min(...ys) }, end: { kind: "pdf", page: target.page, y: Math.max(...ys) }, anchor: { kind: "pdf", page: target.page, quads: target.quads } };
  }
  if (target.kind === "point" && target.point.kind === "pdf") return {
    start: target.point, end: target.point,
    anchor: { kind: "pdf", page: target.point.page, quads: [{ x1: 0, y1: 0, x2: 1, y2: 0, x3: 0, y3: 0.01, x4: 1, y4: 0.01 }] },
  };
  const locator = resolution.kind === "Resolved" ? resolution.anchor.locator : null;
  if (target.kind !== "time" || doc.kind !== "text" || !locator || !("t_end_ms" in locator)) return null;
  const units = doc.units.filter((unit) => unit.time && unit.time.endMs > locator.t_start_ms && unit.time.startMs < locator.t_end_ms);
  const first = units[0], last = units.at(-1);
  if (!first?.time || !last?.time) return null;
  const offset = (unit: typeof first, ms: number) => unit.length * (ms - unit.time!.startMs) / (unit.time!.endMs - unit.time!.startMs);
  const start = offset(first, Math.max(locator.t_start_ms, first.time.startMs));
  const end = offset(last, Math.min(locator.t_end_ms, last.time.endMs));
  return {
    start: { kind: "text", unit: first.id, offset: start },
    end: { kind: "text", unit: last.id, offset: end },
    anchor: { kind: "text", unit: first.id, start: Math.floor(start), end: Math.ceil(offset(first, Math.min(locator.t_end_ms, first.time.endMs))) },
  };
}
