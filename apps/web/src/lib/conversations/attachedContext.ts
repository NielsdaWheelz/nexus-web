import type {
  ContextItem,
  ObjectRefContextItem,
} from "@/lib/api/sse/requests";
import { isObjectType } from "@/lib/objectRefs";
import { isUuid } from "@/lib/validation";

const PENDING_CONTEXT_PARAM = "attach_context";

type PendingObjectContext = Pick<
  ObjectRefContextItem,
  "type" | "id" | "evidence_span_ids"
>;

function parseEvidenceSpanIds(value: string | undefined): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!value) {
    return null;
  }
  const ids = value.split(",").filter(Boolean);
  if (ids.length === 0 || !ids.every(isUuid)) {
    return null;
  }
  return Array.from(new Set(ids));
}

// Shared `${type}:${id}` (plus optional `:${ids}`) wire format used by the
// typed-id URL param and the in-memory identity key.
function encodeTypedId(
  type: string,
  id: string,
  evidenceSpanIds: readonly string[] | undefined,
): string {
  return evidenceSpanIds && evidenceSpanIds.length > 0
    ? `${type}:${id}:${evidenceSpanIds.join(",")}`
    : `${type}:${id}`;
}

function parseTypedId(value: string): ObjectRefContextItem | null {
  const [type, id, evidenceSpanIds, extra] = value.split(":");
  if (extra !== undefined || !type || !id || !isUuid(id) || !isObjectType(type)) {
    return null;
  }
  const parsedEvidenceSpanIds = parseEvidenceSpanIds(evidenceSpanIds);
  if (parsedEvidenceSpanIds === null) {
    return null;
  }
  return {
    kind: "object_ref",
    type,
    id,
    ...(parsedEvidenceSpanIds.length > 0
      ? { evidence_span_ids: parsedEvidenceSpanIds }
      : {}),
  };
}

export function parsePendingContexts(searchParams: URLSearchParams): ObjectRefContextItem[] {
  const contexts: ObjectRefContextItem[] = [];
  for (const rawValue of searchParams.getAll(PENDING_CONTEXT_PARAM)) {
    const parsed = parseTypedId(rawValue);
    if (parsed) {
      contexts.push(parsed);
    }
  }
  return contexts;
}

export function getContextIdentityKey(item: ContextItem): string {
  if (item.kind === "reader_selection") {
    return `reader_selection:${item.client_context_id}`;
  }
  return encodeTypedId(item.type, item.id, item.evidence_span_ids);
}

export function getPendingContextSignature(items: ContextItem[]): string {
  return items.map(getContextIdentityKey).join("");
}

export function mergeContextItems(
  current: ContextItem[],
  incoming: ContextItem[],
): ContextItem[] {
  const seen = new Set(current.map(getContextIdentityKey));
  const next = [...current];
  for (const context of incoming) {
    const key = getContextIdentityKey(context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(context);
  }
  return next;
}

export function stripPendingContextParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const cleaned = new URLSearchParams(searchParams);
  cleaned.delete(PENDING_CONTEXT_PARAM);
  return cleaned;
}

export function setPendingContextParam(
  searchParams: URLSearchParams,
  context: PendingObjectContext,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete(PENDING_CONTEXT_PARAM);
  next.append(
    PENDING_CONTEXT_PARAM,
    encodeTypedId(context.type, context.id, context.evidence_span_ids),
  );
  return next;
}
