import { describe, expect, it } from "vitest";
import { absent } from "@/lib/api/presence";
import type { CitationOut } from "@/lib/conversations/citationOut";
import {
  createConversationFindSnapshot,
  matchConversationFindUnits,
  type ConversationFindSnapshot,
  type ConversationFindUnit,
} from "@/lib/conversations/conversationFind";
import type {
  AssistantTrustTrail,
  ConversationMessage,
  ExpectedChatFailure,
} from "@/lib/conversations/types";
import { createPaneFindResultKey } from "@/lib/panes/paneSearch";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";

const timestamp = "2026-07-29T00:00:00Z";

function citation(ordinal: number): CitationOut {
  return {
    ordinal,
    role: "context",
    target_ref: { type: "media", id: `media-${ordinal}` },
    activation: {
      resourceRef: `media:media-${ordinal}`,
      kind: "route",
      href: `/media/media-${ordinal}`,
      unresolvedReason: null,
    },
    media_id: `media-${ordinal}`,
    locator: null,
    deep_link: `/media/media-${ordinal}`,
    snapshot: null,
  };
}

function trustTrail(failure: ExpectedChatFailure): AssistantTrustTrail {
  return {
    schema_version: "assistant_trust_trail.v1",
    assistant_message_id: "assistant-refused",
    conversation_id: "conversation-1",
    chat_run_id: "run-1",
    status: "error",
    run: {
      run_id: "run-1",
      profile_id: "balanced",
      reasoning_option_id: "default",
      provider: "openai",
      model_name: "gpt-test",
      status: "error",
      usage: null,
      error_code: failure.code,
      error_origin: null,
      failure,
      reasoning_effort: absent(),
      support_id: absent(),
      publication_warning: absent(),
      final_chars: null,
      started_at: null,
      completed_at: null,
      total_cost_usd_micros: null,
    },
    prompt: null,
    tool_calls: [],
    citations: [],
    context_refs_added: [],
    integrity_notices: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function message({
  id,
  seq,
  role,
  blocks,
  status = "complete",
  failure = null,
  citations = [],
}: {
  readonly id: string;
  readonly seq: number;
  readonly role: ConversationMessage["role"];
  readonly blocks: readonly {
    readonly text: string;
    readonly format?: "plain" | "markdown";
  }[];
  readonly status?: ConversationMessage["status"];
  readonly failure?: ExpectedChatFailure | null;
  readonly citations?: readonly CitationOut[];
}): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: blocks.map(({ text, format }) => ({
        type: "text",
        format: format ?? (role === "assistant" ? "markdown" : "plain"),
        text,
      })),
    },
    trust_trail: failure ? trustTrail(failure) : null,
    citations: [...citations],
    status,
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function snapshot(
  messages: readonly ConversationMessage[],
  sourceRevision = 1,
): ConversationFindSnapshot {
  return createConversationFindSnapshot({
    conversationId: "conversation-1",
    activeLeafMessageId: messages.at(-1)?.id ?? null,
    messages,
    sourceRevision,
  });
}

function projectedUnits(
  source: ConversationFindSnapshot,
  texts: readonly string[],
): readonly ConversationFindUnit[] {
  const blockCount = source.messages.reduce(
    (total, item) => total + item.blocks.length,
    0,
  );
  if (texts.length !== blockCount) {
    throw new Error("Test projection must cover every source block.");
  }
  let textIndex = 0;
  return source.messages.flatMap((item) =>
    item.blocks.map((block) => ({
      unitId: block.unitId,
      messageId: item.id,
      messageOrdinal: item.messageOrdinal,
      blockIndex: block.blockIndex,
      role: item.role,
      text: texts[textIndex++]!,
    })),
  );
}

describe("Conversation Find", () => {
  it("selects only terminal visible primary blocks without renumbering the path", () => {
    const source = snapshot([
      message({
        id: "pending",
        seq: 1,
        role: "user",
        status: "pending",
        blocks: [{ text: "changing draft" }],
      }),
      message({
        id: "refused",
        seq: 2,
        role: "assistant",
        status: "error",
        blocks: [{ text: "hidden refusal text" }],
        failure: {
          code: "refused",
          origin: "provider_stream",
          can_rerun: false,
        },
      }),
      message({
        id: "user",
        seq: 3,
        role: "user",
        blocks: [{ text: "visible user" }],
      }),
      message({
        id: "empty-failure",
        seq: 4,
        role: "assistant",
        status: "error",
        blocks: [{ text: "  " }],
      }),
      message({
        id: "partial-failure",
        seq: 5,
        role: "assistant",
        status: "cancelled",
        blocks: [{ text: "visible partial" }],
      }),
      message({
        id: "system",
        seq: 6,
        role: "system",
        blocks: [{ text: "visible system" }],
      }),
    ]);

    expect(
      source.messages.map(({ id, status, messageOrdinal }) => ({
        id,
        status,
        messageOrdinal,
      })),
    ).toEqual([
      { id: "user", status: "complete", messageOrdinal: 3 },
      { id: "partial-failure", status: "cancelled", messageOrdinal: 5 },
      { id: "system", status: "complete", messageOrdinal: 6 },
    ]);
  });

  it("freezes exact source facts while ignoring pending and hidden body churn", () => {
    const baseMessages = [
      message({
        id: "pending",
        seq: 1,
        role: "assistant",
        status: "pending",
        blocks: [{ text: "token one" }],
      }),
      message({
        id: "answer",
        seq: 2,
        role: "assistant",
        blocks: [{ text: "**answer**", format: "markdown" }],
        citations: [citation(2), citation(1)],
      }),
    ];
    const base = snapshot(baseMessages);
    const pendingDelta = snapshot([
      message({
        id: "pending",
        seq: 1,
        role: "assistant",
        status: "pending",
        blocks: [{ text: "token one two three" }],
      }),
      baseMessages[1]!,
    ]);
    const citationMetadataOnly = snapshot([
      baseMessages[0]!,
      {
        ...baseMessages[1]!,
        citations: [citation(1), { ...citation(2), role: "supports" }],
      },
    ]);
    const changedCitationOrdinal = snapshot([
      baseMessages[0]!,
      { ...baseMessages[1]!, citations: [citation(1), citation(3)] },
    ]);
    const terminalized = snapshot([
      { ...baseMessages[0]!, status: "complete" },
      baseMessages[1]!,
    ]);
    const changedLeaf = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "another-leaf",
      messages: baseMessages,
      sourceRevision: 1,
    });

    expect(pendingDelta.sourceKey).toBe(base.sourceKey);
    expect(citationMetadataOnly.sourceKey).toBe(base.sourceKey);
    expect(changedCitationOrdinal.sourceKey).not.toBe(base.sourceKey);
    expect(terminalized.sourceKey).not.toBe(base.sourceKey);
    expect(changedLeaf.sourceKey).not.toBe(base.sourceKey);
  });

  it("matches committed projected text and returns canonical rows in source order", () => {
    const source = snapshot([
      message({
        id: "pending",
        seq: 1,
        role: "user",
        status: "pending",
        blocks: [{ text: "needle" }],
      }),
      message({
        id: "user",
        seq: 2,
        role: "user",
        blocks: [{ text: "😀Alpha alpha" }, { text: "alpha" }],
      }),
      message({
        id: "assistant",
        seq: 3,
        role: "assistant",
        blocks: [{ text: "**alpha**" }],
      }),
    ]);
    const units = projectedUnits(source, ["😀Alpha alpha", "alpha", "alpha"]);
    const result = matchConversationFindUnits({
      snapshot: source,
      units,
      query: "alpha",
      matchCase: false,
      wholeWord: false,
    });

    expect(result.kind).toBe("Ready");
    if (result.kind !== "Ready") return;
    expect(result.completeness).toBe("Complete");
    expect(
      result.occurrences.map(
        ({ messageId, blockIndex, startCp, endCp, row }) => ({
          messageId,
          blockIndex,
          startCp,
          endCp,
          context: row.context,
          snippet: row.snippet,
        }),
      ),
    ).toEqual([
      {
        messageId: "user",
        blockIndex: 0,
        startCp: 1,
        endCp: 6,
        context: ["You", "Message 2"],
        snippet: [
          { text: "😀", emphasized: false },
          { text: "Alpha", emphasized: true },
          { text: " alpha", emphasized: false },
        ],
      },
      {
        messageId: "user",
        blockIndex: 0,
        startCp: 7,
        endCp: 12,
        context: ["You", "Message 2"],
        snippet: [
          { text: "😀Alpha ", emphasized: false },
          { text: "alpha", emphasized: true },
        ],
      },
      {
        messageId: "user",
        blockIndex: 1,
        startCp: 0,
        endCp: 5,
        context: ["You", "Message 2"],
        snippet: [{ text: "alpha", emphasized: true }],
      },
      {
        messageId: "assistant",
        blockIndex: 0,
        startCp: 0,
        endCp: 5,
        context: ["Assistant", "Message 3"],
        snippet: [{ text: "alpha", emphasized: true }],
      },
    ]);
    expect(
      result.occurrences.some(({ startCp }) => startCp > "😀".length),
    ).toBe(true);
  });

  it("inherits whole-word, snippet, non-overlap, and cap behavior from canonicalTextFind", () => {
    const left = "L".repeat(70);
    const right = "R".repeat(70);
    const source = snapshot([
      message({
        id: "system",
        seq: 1,
        role: "system",
        blocks: [{ text: `${left}😀cat catfish cat😀${right}` }],
      }),
    ]);
    const units = projectedUnits(source, [
      `${left}😀cat catfish cat😀${right}`,
    ]);
    const conversationResult = matchConversationFindUnits({
      snapshot: source,
      units,
      query: "cat",
      matchCase: false,
      wholeWord: true,
    });
    const canonicalResult = canonicalTextFind({
      units: units.map(({ unitId: id, text }) => ({ id, text })),
      query: "cat",
      matchCase: false,
      wholeWord: true,
      completeness: "Complete",
    });

    expect(conversationResult.kind).toBe("Ready");
    expect(canonicalResult.kind).toBe("Ready");
    if (
      conversationResult.kind !== "Ready" ||
      canonicalResult.kind !== "Ready"
    ) {
      return;
    }
    expect(
      conversationResult.occurrences.map(
        ({ startCp, endCp, row: { snippet } }) => ({
          startCp,
          endCp,
          snippet,
        }),
      ),
    ).toEqual(
      canonicalResult.occurrences.map(({ startCp, endCp, snippet }) => ({
        startCp,
        endCp,
        snippet,
      })),
    );

    const atLimitSource = snapshot([
      message({
        id: "limit",
        seq: 1,
        role: "user",
        blocks: [{ text: "x".repeat(2_001) }],
      }),
    ]);
    expect(
      matchConversationFindUnits({
        snapshot: atLimitSource,
        units: projectedUnits(atLimitSource, ["x".repeat(2_001)]),
        query: "x",
        matchCase: true,
        wholeWord: false,
      }),
    ).toEqual({ kind: "TooManyMatches", threshold: 2_000 });
  });

  it("uses compact revision-scoped keys with codepoint locators", () => {
    const messages = [
      message({
        id: "user",
        seq: 1,
        role: "user",
        blocks: [{ text: "needle UNRELATED_SECRET_TRANSCRIPT_TEXT" }],
      }),
    ];
    const first = snapshot(messages, 7);
    const second = snapshot(messages, 8);
    const firstResult = matchConversationFindUnits({
      snapshot: first,
      units: projectedUnits(first, [
        "needle UNRELATED_SECRET_TRANSCRIPT_TEXT",
      ]),
      query: "needle",
      matchCase: true,
      wholeWord: false,
    });
    const secondResult = matchConversationFindUnits({
      snapshot: second,
      units: projectedUnits(second, [
        "needle UNRELATED_SECRET_TRANSCRIPT_TEXT",
      ]),
      query: "needle",
      matchCase: true,
      wholeWord: false,
    });

    expect(firstResult.kind).toBe("Ready");
    expect(secondResult.kind).toBe("Ready");
    if (firstResult.kind !== "Ready" || secondResult.kind !== "Ready") return;
    const expectedKey = createPaneFindResultKey({
      source: {
        kind: "ConversationFindSnapshot",
        conversationId: "conversation-1",
        sourceRevision: 7,
      },
      locator: {
        messageId: "user",
        blockIndex: 0,
        startCp: 0,
        endCp: 6,
      },
    });
    expect(firstResult.occurrences[0]).toMatchObject({
      key: expectedKey,
      startCp: 0,
      endCp: 6,
    });
    expect(firstResult.occurrences[0]!.key).not.toContain("needle");
    expect(firstResult.occurrences[0]!.key).not.toContain(
      "UNRELATED_SECRET_TRANSCRIPT_TEXT",
    );
    expect(secondResult.occurrences[0]!.key).not.toBe(expectedKey);
    expect(first.sourceKey).toBe(second.sourceKey);
  });

  it("defects on missing, extra, reordered, or mismatched projected units", () => {
    const source = snapshot([
      message({
        id: "user",
        seq: 1,
        role: "user",
        blocks: [{ text: "one" }, { text: "two" }],
      }),
    ]);
    const units = projectedUnits(source, ["one", "two"]);
    const match = (candidate: readonly ConversationFindUnit[]) =>
      matchConversationFindUnits({
        snapshot: source,
        units: candidate,
        query: "o",
        matchCase: true,
        wholeWord: false,
      });

    expect(() => match(units.slice(0, 1))).toThrow(
      "must cover every searchable block exactly once",
    );
    expect(() => match([...units, units[0]!])).toThrow(
      "must cover every searchable block exactly once",
    );
    expect(() => match([...units].reverse())).toThrow(
      "must preserve source block identity and order",
    );
    expect(() =>
      match([{ ...units[0]!, messageOrdinal: 2 }, units[1]!]),
    ).toThrow("must preserve source block identity and order");
  });
});
