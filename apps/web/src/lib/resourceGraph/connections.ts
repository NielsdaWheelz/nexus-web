import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import {
  parseResourceRef,
  RESOURCE_SCHEMES,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import type { ResourceActivation } from "@/lib/resources/activation";
import {
  decodeResourceActionSubject,
  type ResourceActionSubject,
} from "@/lib/resources/resourceActionTarget";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectInteger,
  expectNullableInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

// Edge vocabulary lives here (its natural home — connections is the sole
// remaining edge-shape-reading module). Mirrors
// `nexus/services/resource_graph/schemas.py`.
export const EDGE_KINDS = ["context", "supports", "contradicts"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_ORIGINS = [
  "user",
  "citation",
  "system",
  "note_body",
  "highlight_note",
  "synapse",
  "document_embed",
  "assistant",
  "link_note",
] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

export interface EdgeOut {
  id: string;
  kind: EdgeKind;
  origin: EdgeOrigin;
  source_ref: string;
  target_ref: string;
  source_order_key: string | null;
  target_order_key: string | null;
  ordinal: number | null;
  snapshot: Record<string, unknown> | null;
  source_label: string;
  source_missing: boolean;
  target_label: string;
  target_missing: boolean;
  created_at: string;
}

export interface ConnectionEndpointOut {
  ref: string;
  scheme: ResourceScheme;
  id: string;
  label: string | null;
  description: string | null;
  activation: ResourceActivation;
  href: string | null;
  missing: boolean;
}

export interface ConnectionActionEndpointOut extends ConnectionEndpointOut {
  actionSubject: ResourceActionSubject;
}

export interface ConnectionCitationOut {
  ordinal: number;
  role: EdgeKind;
  snapshot: Record<string, unknown>;
  activation: ResourceActivation;
  target_reader: ConnectionReaderTargetOut | null;
  target_status: "current" | "missing" | "forbidden" | "unanchorable";
}

export interface ConnectionReaderTargetOut {
  media_id: string | null;
  locator: Record<string, unknown> | null;
}

/**
 * The one ordinary note folded onto a user/context Link, resolved from its two
 * structural `link_note` attachment edges (which never surface as their own
 * connections). Distinct from `ConnectionCitationOut` — this is the Link's note,
 * not a citation projection.
 */
export interface ConnectionLinkNoteOut {
  ref: string;
  note_block_id: string;
  preview: string | null;
}

export interface ConnectionOut {
  edge_id: string;
  direction: "incoming" | "outgoing" | "undirected";
  kind: EdgeKind;
  origin: EdgeOrigin;
  snapshot: Record<string, unknown> | null;
  source_order_key: string | null;
  target_order_key: string | null;
  ordinal: number | null;
  source_ref: string;
  target_ref: string;
  source: ConnectionActionEndpointOut;
  target: ConnectionActionEndpointOut;
  other: ConnectionActionEndpointOut;
  citation: ConnectionCitationOut | null;
  link_note: ConnectionLinkNoteOut | null;
  created_at: string;
}

export interface ConnectionPage {
  items: ConnectionOut[];
  next_cursor: string | null;
}

export interface ConnectionSummaryOut {
  ref: string;
  total: number;
  by_kind: Record<string, number>;
  last_connected_at: string | null;
  dominant_kind: EdgeKind | null;
  top_peers: ConnectionEndpointOut[];
}

interface ConnectionSummaryResponse {
  data: { summaries: ConnectionSummaryOut[] };
}

/** Batch per-ref connection summaries (≤200 refs), AI/synapse excluded by default. */
export async function queryConnectionSummaries(
  refs: string[],
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionSummaryOut[]> {
  if (refs.length === 0) {
    return [];
  }
  const response = await apiFetch<ConnectionSummaryResponse>(
    "/api/resource-graph/connections/summary" as ApiPath,
    {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({ refs }),
    },
  );
  return response.data.summaries;
}

export interface QueryConnectionsInput {
  refs: string[];
  direction: "incoming" | "outgoing" | "both";
  rollup?: "exact" | "owner";
  filters?: {
    origins?: EdgeOrigin[] | null;
    kinds?: EdgeKind[] | null;
    source_schemes?: ResourceScheme[] | null;
    target_schemes?: ResourceScheme[] | null;
  };
  limit?: number;
  cursor?: string | null;
}

interface QueryConnectionsResponse {
  data: unknown;
}

const CONNECTION_KEYS = [
  "edge_id",
  "direction",
  "kind",
  "origin",
  "snapshot",
  "source_order_key",
  "target_order_key",
  "ordinal",
  "source_ref",
  "target_ref",
  "source",
  "target",
  "other",
  "citation",
  "link_note",
  "created_at",
] as const;

function decodeNullableRecord(
  raw: unknown,
  name: string,
): Record<string, unknown> | null {
  return raw === null ? null : expectRecord(raw, name);
}

function decodeActionEndpoint(
  raw: unknown,
  name: string,
): ConnectionActionEndpointOut {
  const value = expectExactRecord(
    raw,
    [
      "ref",
      "scheme",
      "id",
      "label",
      "description",
      "activation",
      "href",
      "missing",
    ],
    name,
  );
  const ref = expectString(value.ref, `${name}.ref`);
  const parsedRef = parseResourceRef(ref);
  if (parsedRef === null) {
    // justify-defect: owned connection endpoints must identify a canonical
    // resource before they can enter the resource-action domain.
    throw new TypeError(`${name}.ref must be a canonical ResourceRef`);
  }
  const scheme = expectOneOf(value.scheme, RESOURCE_SCHEMES, `${name}.scheme`);
  const id = expectString(value.id, `${name}.id`);
  if (parsedRef.scheme !== scheme || parsedRef.id !== id) {
    // justify-defect: the endpoint's decomposed identity must describe the same
    // resource as its canonical ref.
    throw new TypeError(`${name}.scheme/id must equal ${name}.ref`);
  }
  const missing = expectBoolean(value.missing, `${name}.missing`);
  const activation = decodeConnectionActivation(
    value.activation,
    `${name}.activation`,
  );
  const actionSubject = decodeResourceActionSubject(
    { ref },
    `${name}.actionSubject`,
  );
  if (activation.resourceRef !== actionSubject.ref) {
    // justify-defect: occurrence navigation and canonical action identity are
    // separate facts, but an endpoint must publish both for the same resource.
    throw new TypeError(
      `${name}.activation.resource_ref must equal ${name}.ref`,
    );
  }
  const href = expectNullableString(value.href, `${name}.href`);
  if (href !== activation.href) {
    // justify-defect: the endpoint cannot publish two different activation
    // destinations for the same resource.
    throw new TypeError(`${name}.href must equal ${name}.activation.href`);
  }
  return {
    ref,
    scheme,
    id,
    label: expectNullableString(value.label, `${name}.label`),
    description: expectNullableString(value.description, `${name}.description`),
    activation,
    href,
    missing,
    actionSubject,
  };
}

function decodeConnectionActivation(
  raw: unknown,
  name: string,
): ResourceActivation {
  const value = expectExactRecord(
    raw,
    ["resource_ref", "kind", "href", "unresolved_reason"],
    name,
  );
  const ref = expectString(value.resource_ref, `${name}.resource_ref`);
  const activation = {
    resourceRef: ref,
    kind: expectOneOf(
      value.kind,
      ["route", "external", "none"] as const,
      `${name}.kind`,
    ),
    href: expectNullableString(value.href, `${name}.href`),
    unresolvedReason: expectNullableString(
      value.unresolved_reason,
      `${name}.unresolved_reason`,
    ),
  };
  decodeResourceActionSubject({ ref }, `${name}.subject`);
  return activation;
}

function decodeConnectionReaderTarget(
  raw: unknown,
  name: string,
): ConnectionReaderTargetOut {
  const value = expectExactRecord(raw, ["media_id", "locator"], name);
  return {
    media_id: expectNullableString(value.media_id, `${name}.media_id`),
    locator: decodeNullableRecord(value.locator, `${name}.locator`),
  };
}

function decodeConnectionCitation(
  raw: unknown,
  name: string,
): ConnectionCitationOut | null {
  if (raw === null) return null;
  const value = expectExactRecord(
    raw,
    [
      "ordinal",
      "role",
      "snapshot",
      "activation",
      "target_reader",
      "target_status",
    ],
    name,
  );
  return {
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    role: expectOneOf(value.role, EDGE_KINDS, `${name}.role`),
    snapshot: expectRecord(value.snapshot, `${name}.snapshot`),
    activation: decodeConnectionActivation(
      value.activation,
      `${name}.activation`,
    ),
    target_reader:
      value.target_reader === null
        ? null
        : decodeConnectionReaderTarget(
            value.target_reader,
            `${name}.target_reader`,
          ),
    target_status: expectOneOf(
      value.target_status,
      ["current", "missing", "forbidden", "unanchorable"] as const,
      `${name}.target_status`,
    ),
  };
}

function decodeConnectionLinkNote(
  raw: unknown,
  name: string,
): ConnectionLinkNoteOut | null {
  if (raw === null) return null;
  const value = expectExactRecord(
    raw,
    ["ref", "note_block_id", "preview"],
    name,
  );
  const ref = expectString(value.ref, `${name}.ref`);
  const parsedRef = parseResourceRef(ref);
  const noteBlockId = expectString(
    value.note_block_id,
    `${name}.note_block_id`,
  );
  if (parsedRef?.scheme !== "note_block" || parsedRef.id !== noteBlockId) {
    // justify-defect: a folded Link note must identify exactly one canonical
    // note block across both of its wire identity fields.
    throw new TypeError(`${name}.ref must identify ${name}.note_block_id`);
  }
  return {
    ref,
    note_block_id: noteBlockId,
    preview: expectNullableString(value.preview, `${name}.preview`),
  };
}

export function decodeConnectionOut(
  raw: unknown,
  name = "Connection",
): ConnectionOut {
  const value = expectExactRecord(raw, CONNECTION_KEYS, name);
  const sourceRef = expectString(value.source_ref, `${name}.source_ref`);
  const targetRef = expectString(value.target_ref, `${name}.target_ref`);
  if (
    parseResourceRef(sourceRef) === null ||
    parseResourceRef(targetRef) === null
  ) {
    // justify-defect: connection edges cannot enter the frontend with
    // non-canonical endpoint refs.
    throw new TypeError(`${name} source/target refs must be canonical`);
  }
  const source = decodeActionEndpoint(value.source, `${name}.source`);
  const target = decodeActionEndpoint(value.target, `${name}.target`);
  const other = decodeActionEndpoint(value.other, `${name}.other`);
  if (
    source.ref !== sourceRef ||
    target.ref !== targetRef ||
    (other.ref !== sourceRef && other.ref !== targetRef)
  ) {
    // justify-defect: hydrated connection endpoints must agree with the edge
    // identity fields that own the relationship.
    throw new TypeError(`${name} endpoint refs must match the edge refs`);
  }
  return {
    edge_id: expectString(value.edge_id, `${name}.edge_id`),
    direction: expectOneOf(
      value.direction,
      ["incoming", "outgoing", "undirected"] as const,
      `${name}.direction`,
    ),
    kind: expectOneOf(value.kind, EDGE_KINDS, `${name}.kind`),
    origin: expectOneOf(value.origin, EDGE_ORIGINS, `${name}.origin`),
    snapshot: decodeNullableRecord(value.snapshot, `${name}.snapshot`),
    source_order_key: expectNullableString(
      value.source_order_key,
      `${name}.source_order_key`,
    ),
    target_order_key: expectNullableString(
      value.target_order_key,
      `${name}.target_order_key`,
    ),
    ordinal: expectNullableInteger(value.ordinal, `${name}.ordinal`),
    source_ref: sourceRef,
    target_ref: targetRef,
    source,
    target,
    other,
    citation: decodeConnectionCitation(value.citation, `${name}.citation`),
    link_note: decodeConnectionLinkNote(value.link_note, `${name}.link_note`),
    created_at: expectString(value.created_at, `${name}.created_at`),
  };
}

function decodeConnectionPage(raw: unknown): ConnectionPage {
  const value = expectExactRecord(
    raw,
    ["items", "next_cursor"],
    "ConnectionPage",
  );
  return {
    items: expectArray(
      value.items,
      (item, index) =>
        decodeConnectionOut(item, `ConnectionPage.items[${index}]`),
      "ConnectionPage.items",
    ),
    next_cursor: expectNullableString(
      value.next_cursor,
      "ConnectionPage.next_cursor",
    ),
  };
}

export async function queryConnections(
  input: QueryConnectionsInput,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionPage> {
  const response = await apiFetch<QueryConnectionsResponse>(
    "/api/resource-graph/connections/query" as ApiPath,
    {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify(input),
    },
  );
  return decodeConnectionPage(response.data);
}
