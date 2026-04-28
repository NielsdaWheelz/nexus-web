import type { ContextItem } from "@/lib/api/sse";
import type { ConversationScope } from "@/lib/conversations/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PENDING_CONTEXT_PARAM = "context";
const PENDING_SCOPE_PARAM = "scope";

function parseTypedId(value: string): { type: ContextItem["type"]; id: string } | null {
  const [type, id, extra] = value.split(":");
  if (extra !== undefined || !id || !UUID_RE.test(id)) {
    return null;
  }
  if (type === "highlight" || type === "annotation" || type === "media") {
    return { type, id };
  }
  return null;
}

export function parsePendingContexts(searchParams: URLSearchParams): ContextItem[] {
  const contexts: ContextItem[] = [];
  for (const rawValue of searchParams.getAll(PENDING_CONTEXT_PARAM)) {
    const parsed = parseTypedId(rawValue);
    if (parsed) {
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
  if (extra !== undefined || !id || !UUID_RE.test(id)) {
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

export function getPendingContextSignature(items: ContextItem[]): string {
  return items.map((item) => `${item.type}:${item.id}`).join("\u001e");
}

export function getConversationScopeSignature(scope: ConversationScope): string {
  if (scope.type === "general") {
    return "general";
  }
  if (scope.type === "media") {
    return `media:${scope.media_id}`;
  }
  if (scope.type === "library") {
    return `library:${scope.library_id}`;
  }
  const exhaustive: never = scope;
  return exhaustive;
}

export function stripPendingContextParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const cleaned = new URLSearchParams(searchParams);
  cleaned.delete(PENDING_CONTEXT_PARAM);
  cleaned.delete(PENDING_SCOPE_PARAM);
  return cleaned;
}

export function setPendingContextParam(
  searchParams: URLSearchParams,
  context: Pick<ContextItem, "type" | "id">,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete(PENDING_CONTEXT_PARAM);
  next.append(PENDING_CONTEXT_PARAM, `${context.type}:${context.id}`);
  return next;
}

export function setConversationScopeParam(
  searchParams: URLSearchParams,
  scope: ConversationScope,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (scope.type === "general") {
    next.delete(PENDING_SCOPE_PARAM);
    return next;
  }
  if (scope.type === "media") {
    next.set(PENDING_SCOPE_PARAM, `media:${scope.media_id}`);
    return next;
  }
  if (scope.type === "library") {
    next.set(PENDING_SCOPE_PARAM, `library:${scope.library_id}`);
    return next;
  }
  const exhaustive: never = scope;
  return exhaustive;
}
