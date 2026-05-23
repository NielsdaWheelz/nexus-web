import {
  isRetrievalLocator,
  type ContextItem,
  type ObjectRefContextItem,
} from "@/lib/api/sse";
import type { ConversationScope } from "@/lib/conversations/types";
import { isObjectType } from "@/lib/objectRefs";
import { isRecord, isUuid } from "@/lib/validation";

const PENDING_CONTEXT_PARAM = "attach_context";
const PENDING_CONTEXT_JSON_PARAM = "attach_context_json";
const PENDING_SCOPE_PARAM = "scope";

type PendingObjectContext = Pick<ObjectRefContextItem, "type" | "id" | "evidence_span_ids"> &
  Partial<
    Pick<
      ObjectRefContextItem,
      | "kind"
      | "artifact_id"
      | "artifact_key"
      | "artifact_version"
      | "source_version"
      | "locator"
      | "artifact_part_provenance"
    >
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

// Shared scope wire format. Returns the URL-param value, or null to mean
// "no param" (the general scope).
function encodeScopeForUrl(scope: ConversationScope): string | null {
  if (scope.type === "general") return null;
  if (scope.type === "media") return `media:${scope.media_id}`;
  if (scope.type === "library") return `library:${scope.library_id}`;
  const exhaustive: never = scope;
  return exhaustive;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return typeof value === "string" ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function parseJsonContext(value: string): ObjectRefContextItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.kind !== undefined && parsed.kind !== "object_ref") {
    return null;
  }
  if (
    typeof parsed.type !== "string" ||
    !isObjectType(parsed.type) ||
    typeof parsed.id !== "string" ||
    !isUuid(parsed.id)
  ) {
    return null;
  }
  const evidenceSpanIds = Array.isArray(parsed.evidence_span_ids)
    ? parsed.evidence_span_ids
    : undefined;
  if (
    evidenceSpanIds !== undefined &&
    !evidenceSpanIds.every((id) => typeof id === "string" && isUuid(id))
  ) {
    return null;
  }
  const sourceVersion = optionalString(parsed.source_version);
  const artifactKey = optionalString(parsed.artifact_key);
  const artifactVersion = optionalPositiveInteger(parsed.artifact_version);
  if (
    sourceVersion === undefined ||
    artifactKey === undefined ||
    artifactVersion === undefined
  ) {
    return null;
  }

  const context: ObjectRefContextItem = {
    kind: "object_ref",
    type: parsed.type,
    id: parsed.id,
    ...(evidenceSpanIds?.length ? { evidence_span_ids: Array.from(new Set(evidenceSpanIds)) } : {}),
    ...(sourceVersion ? { source_version: sourceVersion } : {}),
  };
  if (artifactKey !== null && artifactKey !== undefined) {
    context.artifact_key = artifactKey;
  }
  if (artifactVersion !== null && artifactVersion !== undefined) {
    context.artifact_version = artifactVersion;
  }

  if (parsed.type !== "artifact_part") {
    return context;
  }
  if (
    typeof parsed.artifact_id !== "string" ||
    !isUuid(parsed.artifact_id) ||
    typeof sourceVersion !== "string" ||
    !sourceVersion ||
    !isRetrievalLocator(parsed.locator) ||
    parsed.locator.type !== "artifact_part_ref" ||
    !isRecord(parsed.artifact_part_provenance)
  ) {
    return null;
  }
  return {
    ...context,
    artifact_id: parsed.artifact_id,
    locator: parsed.locator,
    artifact_part_provenance: parsed.artifact_part_provenance,
  };
}

export function parsePendingContexts(searchParams: URLSearchParams): ObjectRefContextItem[] {
  const contexts: ObjectRefContextItem[] = [];
  for (const rawValue of searchParams.getAll(PENDING_CONTEXT_JSON_PARAM)) {
    const parsed = parseJsonContext(rawValue);
    if (parsed) {
      contexts.push(parsed);
    }
  }
  for (const rawValue of searchParams.getAll(PENDING_CONTEXT_PARAM)) {
    const parsed = parseTypedId(rawValue);
    if (parsed && parsed.type !== "artifact_part") {
      contexts.push(parsed);
    }
  }
  return contexts;
}

export function parseConversationScopeFromUrl(
  searchParams: URLSearchParams,
): ConversationScope {
  const rawScope = searchParams.get(PENDING_SCOPE_PARAM);
  if (!rawScope) {
    return { type: "general" };
  }

  const [type, id, extra] = rawScope.split(":");
  if (extra !== undefined || !id || !isUuid(id)) {
    return { type: "general" };
  }
  if (type === "media") {
    return { type: "media", media_id: id };
  }
  if (type === "library") {
    return { type: "library", library_id: id };
  }
  return { type: "general" };
}

export function getContextIdentityKey(item: ContextItem): string {
  if (item.kind === "reader_selection") {
    return `reader_selection:${item.client_context_id}`;
  }
  return encodeTypedId(item.type, item.id, item.evidence_span_ids);
}

export function getPendingContextSignature(items: ContextItem[]): string {
  return items.map(getContextIdentityKey).join("\u001e");
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

export function getConversationScopeSignature(scope: ConversationScope): string {
  return encodeScopeForUrl(scope) ?? "general";
}

export function stripPendingContextParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const cleaned = new URLSearchParams(searchParams);
  cleaned.delete(PENDING_CONTEXT_PARAM);
  cleaned.delete(PENDING_CONTEXT_JSON_PARAM);
  cleaned.delete(PENDING_SCOPE_PARAM);
  return cleaned;
}

export function setPendingContextParam(
  searchParams: URLSearchParams,
  context: PendingObjectContext,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete(PENDING_CONTEXT_PARAM);
  next.delete(PENDING_CONTEXT_JSON_PARAM);
  if (context.type === "artifact_part") {
    if (
      !context.artifact_id ||
      !context.source_version ||
      !context.locator ||
      context.locator.type !== "artifact_part_ref" ||
      !context.artifact_part_provenance
    ) {
      return next;
    }
    next.append(
      PENDING_CONTEXT_JSON_PARAM,
      JSON.stringify({
        kind: "object_ref",
        type: context.type,
        id: context.id,
        ...(context.evidence_span_ids?.length
          ? { evidence_span_ids: context.evidence_span_ids }
          : {}),
        artifact_id: context.artifact_id,
        artifact_key: context.artifact_key,
        artifact_version: context.artifact_version,
        source_version: context.source_version,
        locator: context.locator,
        artifact_part_provenance: context.artifact_part_provenance,
      }),
    );
    return next;
  }
  next.append(
    PENDING_CONTEXT_PARAM,
    encodeTypedId(context.type, context.id, context.evidence_span_ids),
  );
  return next;
}

export function setConversationScopeParam(
  searchParams: URLSearchParams,
  scope: ConversationScope,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  const value = encodeScopeForUrl(scope);
  if (value === null) {
    next.delete(PENDING_SCOPE_PARAM);
  } else {
    next.set(PENDING_SCOPE_PARAM, value);
  }
  return next;
}
