import type { Presence } from "@/lib/api/presence";
import type { BranchAnchor } from "@/lib/conversations/types";

/** The reader quote piece of a send: durable key + compare-on-send revision
 *  only. The server derives exact/prefix/suffix/source/locator from the locked
 *  Highlight; client quote text is never sent. */
export interface ReaderSelectionInput {
  key: { media_id: string; highlight_id: string };
  revision: string;
}

export type ChatInsertionInput =
  | { kind: "Empty" }
  | { kind: "Reply"; parent_message_id: string; branch_anchor: BranchAnchor };

export type ChatDestinationInput =
  | { kind: "New" }
  | { kind: "Existing"; conversation_id: string; insertion: ChatInsertionInput };

export interface ChatRunCreateRequest {
  destination: ChatDestinationInput;
  content: string;
  profile_id: string;
  reasoning_option_id: string;
  reader_selection: Presence<ReaderSelectionInput>;
}
