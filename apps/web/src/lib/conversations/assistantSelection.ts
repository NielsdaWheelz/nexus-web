import type { BranchAnchor } from "@/lib/conversations/types";

export type AssistantSelectionOffsetStatus = "mapped" | "unmapped";

export interface AssistantSelectionMapping {
  offset_status: AssistantSelectionOffsetStatus;
  start_offset: number | null;
  end_offset: number | null;
}

export function mapAssistantSelectionToSource(
  source: string,
  renderedText: string,
  exact: string,
): AssistantSelectionMapping {
  if (!exact || source !== renderedText) {
    return {
      offset_status: "unmapped",
      start_offset: null,
      end_offset: null,
    };
  }

  const matches: number[] = [];
  for (let index = 0; index <= source.length - exact.length; index += 1) {
    if (source.startsWith(exact, index)) {
      matches.push(index);
    }
  }

  if (matches.length !== 1) {
    return {
      offset_status: "unmapped",
      start_offset: null,
      end_offset: null,
    };
  }

  const start = matches[0];
  const end = start + exact.length;
  if (source.slice(start, end) !== exact) {
    return {
      offset_status: "unmapped",
      start_offset: null,
      end_offset: null,
    };
  }

  return {
    offset_status: "mapped",
    start_offset: start,
    end_offset: end,
  };
}

export function assistantSelectionAnchor({
  messageId,
  exact,
  prefix,
  suffix,
  clientSelectionId,
  mapping,
}: {
  messageId: string;
  exact: string;
  prefix: string | null;
  suffix: string | null;
  clientSelectionId: string;
  mapping: AssistantSelectionMapping;
}): Extract<BranchAnchor, { kind: "assistant_selection" }> {
  if (
    mapping.offset_status === "mapped" &&
    typeof mapping.start_offset === "number" &&
    typeof mapping.end_offset === "number"
  ) {
    return {
      kind: "assistant_selection",
      message_id: messageId,
      exact,
      prefix,
      suffix,
      offset_status: "mapped",
      start_offset: mapping.start_offset,
      end_offset: mapping.end_offset,
      client_selection_id: clientSelectionId,
    };
  }

  return {
    kind: "assistant_selection",
    message_id: messageId,
    exact,
    prefix,
    suffix,
    offset_status: "unmapped",
    client_selection_id: clientSelectionId,
  };
}
