import { isCanonicalUuid } from "@/lib/validation";

// A pane's endpoint is independent of the conversation's last admitted send.
// Absence seeds a new view once; explicit empty remains empty after other sends.
export type ConversationEndpoint =
  | { kind: "Unspecified" }
  | { kind: "Invalid" }
  | { kind: "Endpoint"; messageId: string | null };

export function conversationEndpoint(params: URLSearchParams): ConversationEndpoint {
  const values = params.getAll("leaf");
  if (values.length === 0) return { kind: "Unspecified" };
  if (values.length !== 1) return { kind: "Invalid" };
  const value = values[0];
  if (value === "empty") return { kind: "Endpoint", messageId: null };
  return isCanonicalUuid(value)
    ? { kind: "Endpoint", messageId: value }
    : { kind: "Invalid" };
}

export function conversationViewHref(conversationId: string, messageId: string | null): string {
  return `/conversations/${conversationId}?leaf=${messageId ?? "empty"}`;
}
