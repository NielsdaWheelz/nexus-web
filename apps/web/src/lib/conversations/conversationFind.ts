import type { ConversationMessage } from "@/lib/conversations/types";
import { isAssistantPrimaryBodyVisible } from "@/lib/conversations/conversationPresentation";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindIdentityValue,
  type PaneFindResultKey,
  type PaneFindResultRow,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";

type ConversationFindTerminalStatus = Exclude<
  ConversationMessage["status"],
  "pending"
>;

interface ConversationFindSourceBlock {
  readonly unitId: string;
  readonly blockIndex: number;
}

interface ConversationFindMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: ConversationMessage["role"];
  readonly status: ConversationFindTerminalStatus;
  readonly messageOrdinal: number;
  readonly blocks: readonly ConversationFindSourceBlock[];
}

export interface ConversationFindSnapshot {
  readonly conversationId: string | null;
  readonly sourceKey: PaneFindSourceKey;
  readonly sourceRevision: number;
  readonly messages: readonly ConversationFindMessage[];
}

export interface ConversationFindUnit {
  readonly unitId: string;
  readonly messageId: string;
  readonly messageOrdinal: number;
  readonly blockIndex: number;
  readonly role: ConversationMessage["role"];
  readonly text: string;
}

export interface ConversationFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly messageId: string;
  readonly blockIndex: number;
  readonly startCp: number;
  readonly endCp: number;
  readonly row: PaneFindResultRow;
}

type ConversationFindMatches =
  | {
      readonly kind: "NoMatches";
      readonly completeness: "Complete";
    }
  | {
      readonly kind: "Ready";
      readonly completeness: "Complete";
      readonly occurrences: readonly ConversationFindOccurrence[];
    }
  | { readonly kind: "TooManyMatches"; readonly threshold: 2_000 };

function resolvedCitationOrdinals(
  message: ConversationMessage,
): readonly number[] {
  return [...new Set((message.citations ?? []).map(({ ordinal }) => ordinal))].sort(
    (left, right) => left - right,
  );
}

export function createConversationFindSnapshot({
  conversationId,
  activeLeafMessageId,
  messages,
  sourceRevision,
}: {
  readonly conversationId: string | null;
  readonly activeLeafMessageId: string | null;
  readonly messages: readonly ConversationMessage[];
  readonly sourceRevision: number;
}): ConversationFindSnapshot {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new Error(
      "Conversation Find source revision must be a nonnegative safe integer.",
    );
  }

  const sourceMessages: PaneFindIdentityValue[] = [];
  const searchableMessages: ConversationFindMessage[] = [];
  messages.forEach((message, messageIndex) => {
    const terminal = message.status !== "pending";
    const bodyVisible =
      message.role !== "assistant" || isAssistantPrimaryBodyVisible(message);
    const searchable = terminal && bodyVisible;
    const sourceBlocks = searchable
      ? (message.message_document?.blocks ?? []).map((block, blockIndex) => ({
          blockIndex,
          format: block.format,
          text: block.text,
        }))
      : [];
    const blocks = sourceBlocks.map(({ blockIndex }) => ({
      unitId: JSON.stringify([message.id, blockIndex]),
      blockIndex,
    }));
    const citationOrdinals =
      searchable && message.role === "assistant"
        ? resolvedCitationOrdinals(message)
        : [];

    sourceMessages.push({
      id: message.id,
      seq: message.seq,
      role: message.role,
      status: message.status,
      primaryBodyVisible: bodyVisible,
      blocks: sourceBlocks,
      resolvedCitationOrdinals: citationOrdinals,
    });
    if (message.status === "pending" || !bodyVisible) return;
    searchableMessages.push({
      id: message.id,
      seq: message.seq,
      role: message.role,
      status: message.status,
      messageOrdinal: messageIndex + 1,
      blocks,
    });
  });

  return {
    conversationId,
    sourceKey: createPaneFindSourceKey({
      kind: "ConversationFindSource",
      conversationId,
      activeLeafMessageId,
      messages: sourceMessages,
    }),
    sourceRevision,
    messages: searchableMessages,
  };
}

function roleLabel(role: ConversationMessage["role"]): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
  }
}

function expectedUnits(
  snapshot: ConversationFindSnapshot,
): readonly Omit<ConversationFindUnit, "text">[] {
  return snapshot.messages.flatMap((message) =>
    message.blocks.map((block) => ({
      unitId: block.unitId,
      messageId: message.id,
      messageOrdinal: message.messageOrdinal,
      blockIndex: block.blockIndex,
      role: message.role,
    })),
  );
}

function assertExactProjectedUnits(
  snapshot: ConversationFindSnapshot,
  units: readonly ConversationFindUnit[],
): void {
  const expected = expectedUnits(snapshot);
  if (units.length !== expected.length) {
    throw new Error(
      "Conversation Find projected units must cover every searchable block exactly once.",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = units[index]!;
    const source = expected[index]!;
    if (
      actual.unitId !== source.unitId ||
      actual.messageId !== source.messageId ||
      actual.messageOrdinal !== source.messageOrdinal ||
      actual.blockIndex !== source.blockIndex ||
      actual.role !== source.role
    ) {
      throw new Error(
        "Conversation Find projected units must preserve source block identity and order.",
      );
    }
  }
}

export function matchConversationFindUnits({
  snapshot,
  units,
  query,
  matchCase,
  wholeWord,
}: {
  readonly snapshot: ConversationFindSnapshot;
  readonly units: readonly ConversationFindUnit[];
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}): ConversationFindMatches {
  assertExactProjectedUnits(snapshot, units);
  if (snapshot.conversationId === null) {
    throw new Error(
      "Conversation Find matching requires a loaded existing conversation.",
    );
  }
  const result = canonicalTextFind({
    units: units.map(({ unitId: id, text }) => ({ id, text })),
    query,
    matchCase,
    wholeWord,
    completeness: "Complete",
  });
  if (result.kind === "TooManyMatches") return result;
  if (result.kind === "NoMatches") {
    return { kind: "NoMatches", completeness: "Complete" };
  }

  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const source = {
    kind: "ConversationFindSnapshot",
    conversationId: snapshot.conversationId,
    sourceRevision: snapshot.sourceRevision,
  } as const;
  return {
    kind: "Ready",
    completeness: "Complete",
    occurrences: result.occurrences.map((occurrence) => {
      const unit = unitById.get(occurrence.unitId);
      if (!unit) {
        throw new Error(
          "Canonical Conversation Find returned an unknown projected unit.",
        );
      }
      const locator = {
        messageId: unit.messageId,
        blockIndex: unit.blockIndex,
        startCp: occurrence.startCp,
        endCp: occurrence.endCp,
      };
      const key = createPaneFindResultKey({ source, locator });
      return {
        key,
        ...locator,
        row: {
          key,
          context: [roleLabel(unit.role), `Message ${unit.messageOrdinal}`],
          snippet: occurrence.snippet,
        },
      };
    }),
  };
}
