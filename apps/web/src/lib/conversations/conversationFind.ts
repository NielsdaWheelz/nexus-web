import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { ConversationMessage } from "@/lib/conversations/types";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindIdentityValue,
  type PaneFindResultKey,
  type PaneFindResultRow,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";

export const CONVERSATION_FIND_MATCH_THRESHOLD = 2_000;

const SNIPPET_CONTEXT_CODEPOINTS = 48;
const WORD_CODEPOINT =
  /[\p{Letter}\p{Number}\p{Mark}\p{Connector_Punctuation}]/u;

interface ConversationFindBlock {
  readonly blockIndex: number;
  readonly format: "plain" | "markdown";
  readonly text: string;
}

interface ConversationFindMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: ConversationMessage["role"];
  readonly blocks: readonly ConversationFindBlock[];
  readonly sourceIdentity: PaneFindIdentityValue;
}

export interface ConversationFindSnapshot {
  readonly sourceIdentity: PaneFindIdentityValue;
  readonly sourceKey: PaneFindSourceKey;
  readonly messages: readonly ConversationFindMessage[];
}

export interface ConversationFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly messageId: string;
  readonly blockIndex: number;
  readonly start: number;
  readonly end: number;
  readonly row: PaneFindResultRow;
}

export type ConversationFindMatches =
  | { readonly kind: "NoMatches" }
  | {
      readonly kind: "Ready";
      readonly occurrences: readonly ConversationFindOccurrence[];
    }
  | { readonly kind: "TooManyMatches"; readonly threshold: number };

function roleLabel(role: ConversationMessage["role"]): string {
  switch (role) {
    case "user":
      return "Your message";
    case "assistant":
      return "Assistant response";
    case "system":
      return "System message";
  }
}

export function createConversationFindSnapshot({
  conversationId,
  activeLeafMessageId,
  messages,
}: {
  readonly conversationId: string | null;
  readonly activeLeafMessageId: string | null;
  readonly messages: readonly ConversationMessage[];
}): ConversationFindSnapshot {
  const searchableMessages = messages.map((message) => {
    const blocks = (message.message_document?.blocks ?? []).map(
      (block, blockIndex) => ({
        blockIndex,
        format: block.format,
        text: block.text,
      }),
    );
    return {
      id: message.id,
      seq: message.seq,
      role: message.role,
      blocks,
      sourceIdentity: {
        kind: "ConversationMessage",
        conversationId,
        messageId: message.id,
        seq: message.seq,
        role: message.role,
        blocks,
      },
    };
  });
  const sourceIdentity = {
    kind: "ConversationTranscript",
    conversationId,
    activeLeafMessageId,
    messages: searchableMessages.map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      blocks: message.blocks.map((block) => ({
        blockIndex: block.blockIndex,
        format: block.format,
        text: block.text,
      })),
    })),
  };
  return {
    sourceIdentity,
    sourceKey: createPaneFindSourceKey(sourceIdentity),
    messages: searchableMessages,
  };
}

function codePointBefore(text: string, offset: number): string {
  return Array.from(text.slice(0, offset)).at(-1) ?? "";
}

function codePointAfter(text: string, offset: number): string {
  return Array.from(text.slice(offset))[0] ?? "";
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start);
  const after = codePointAfter(text, end);
  return (
    (!before || !WORD_CODEPOINT.test(before)) &&
    (!after || !WORD_CODEPOINT.test(after))
  );
}

function literalMatches(
  candidate: string,
  query: string,
  matchCase: boolean,
): boolean {
  if (matchCase) return candidate === query;
  // The fixed-length candidate window keeps source offsets exact. Unicode
  // lowercase mappings that expand (for example, Turkish capital dotted I)
  // intentionally do not match a shorter query.
  return candidate.toLowerCase() === query.toLowerCase();
}

function snippetStart(text: string, start: number): number {
  const context = Array.from(text.slice(0, start))
    .slice(-SNIPPET_CONTEXT_CODEPOINTS)
    .join("");
  return start - context.length;
}

function snippetEnd(text: string, end: number): number {
  return (
    end +
    Array.from(text.slice(end))
      .slice(0, SNIPPET_CONTEXT_CODEPOINTS)
      .join("").length
  );
}

function snippetSegments(
  text: string,
  start: number,
  end: number,
): readonly EmphasisSegment[] {
  const from = snippetStart(text, start);
  const to = snippetEnd(text, end);
  const segments = [
    { text: text.slice(from, start), emphasized: false },
    { text: text.slice(start, end), emphasized: true },
    { text: text.slice(end, to), emphasized: false },
  ];
  return segments.filter((segment) => segment.text.length > 0);
}

export function findConversationOccurrences({
  snapshot,
  query,
  matchCase,
  wholeWord,
}: {
  readonly snapshot: ConversationFindSnapshot;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}): ConversationFindMatches {
  if (query.length === 0) {
    throw new Error("Conversation Find requires a non-empty literal query.");
  }
  const occurrences: ConversationFindOccurrence[] = [];
  for (
    let messageIndex = 0;
    messageIndex < snapshot.messages.length;
    messageIndex += 1
  ) {
    const message = snapshot.messages[messageIndex]!;
    for (const block of message.blocks) {
      let offset = 0;
      while (offset <= block.text.length - query.length) {
        const end = offset + query.length;
        const candidate = block.text.slice(offset, end);
        if (
          literalMatches(candidate, query, matchCase) &&
          (!wholeWord || isWholeWord(block.text, offset, end))
        ) {
          if (occurrences.length === CONVERSATION_FIND_MATCH_THRESHOLD) {
            return {
              kind: "TooManyMatches",
              threshold: CONVERSATION_FIND_MATCH_THRESHOLD,
            };
          }
          const key = createPaneFindResultKey({
            source: message.sourceIdentity,
            locator: {
              messageId: message.id,
              blockIndex: block.blockIndex,
              start: offset,
              end,
            },
          });
          occurrences.push({
            key,
            messageId: message.id,
            blockIndex: block.blockIndex,
            start: offset,
            end,
            row: {
              key,
              context: [
                roleLabel(message.role),
                `Message ${messageIndex + 1}`,
              ],
              snippet: snippetSegments(block.text, offset, end),
            },
          });
          offset = end;
          continue;
        }
        offset += 1;
      }
    }
  }
  return occurrences.length === 0
    ? { kind: "NoMatches" }
    : { kind: "Ready", occurrences };
}
