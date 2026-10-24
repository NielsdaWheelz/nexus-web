// A chat match names rendered codepoints on one explicit branch, never markdown
// offsets or copied prose. The loaded conversation owns membership and digest checks.
import { parseLocationJson } from "@/lib/reader/locationJson";
import { isCanonicalUuid, isRecord } from "@/lib/validation";
import { MAX_WORKSPACE_HREF_LENGTH } from "@/lib/workspace/workspaceHref";
import { conversationViewHref } from "./view";

export interface ChatFindDestination {
  readonly kind: "find_match";
  readonly message_id: string;
  readonly start: number;
  readonly end: number;
  readonly text_sha256: string;
}

export function parseChatFindDestination(raw: string): ChatFindDestination | null {
  const value = parseLocationJson(raw);
  if (!isRecord(value) || Object.keys(value).length !== 5 ||
    !["kind", "message_id", "start", "end", "text_sha256"].every((key) => Object.hasOwn(value, key)) ||
    value.kind !== "find_match" || !isCanonicalUuid(value.message_id) ||
    typeof value.start !== "number" || !Number.isSafeInteger(value.start) || value.start < 0 ||
    typeof value.end !== "number" || !Number.isSafeInteger(value.end) || value.end <= value.start ||
    typeof value.text_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.text_sha256)) return null;
  return { kind: value.kind, message_id: value.message_id, start: value.start, end: value.end, text_sha256: value.text_sha256 };
}

/** A pure projection of the captured match; no source inspection precedes opening. */
export function chatFindDestinationHref(conversationId: string, leafId: string, destination: ChatFindDestination): string | null {
  const href = `${conversationViewHref(conversationId, leafId)}&${new URLSearchParams({ loc: JSON.stringify(destination) })}`;
  return href.length <= MAX_WORKSPACE_HREF_LENGTH ? href : null;
}
