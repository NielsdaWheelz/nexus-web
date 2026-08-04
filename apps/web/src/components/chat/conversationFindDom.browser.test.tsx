import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AssistantAnswer from "@/components/chat/AssistantAnswer";
import {
  prepareConversationFindUnits,
  resolveConversationFindRanges,
} from "@/components/chat/conversationFindDom";
import {
  createConversationFindSnapshot,
  matchConversationFindUnits,
  type ConversationFindOccurrence,
} from "@/lib/conversations/conversationFind";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ConversationMessage } from "@/lib/conversations/types";

const MESSAGE_ID = "assistant-8";
const RICH_MARKDOWN =
  "**Bold signal** and [Link label](https://hidden.example/path) keep " +
  "`inline 🎉` visible. Cafe\u0301   au\tlait[1].\n\n" +
  "```ts\nconst x = \"orbit\";\n```\n\n" +
  "bridge";
const SECOND_BLOCK = "word after";

const citationOut: CitationOut = {
  ordinal: 1,
  role: "context",
  target_ref: {
    type: "media",
    id: "11111111-1111-4111-8111-111111111111",
  },
  activation: {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
  },
  media_id: "11111111-1111-4111-8111-111111111111",
  locator: null,
  deep_link: "/media/11111111-1111-4111-8111-111111111111",
  snapshot: null,
};

const message: ConversationMessage = {
  id: MESSAGE_ID,
  seq: 8,
  role: "assistant",
  message_document: {
    type: "message_document",
    blocks: [
      { type: "text", format: "markdown", text: RICH_MARKDOWN },
      { type: "text", format: "markdown", text: SECOND_BLOCK },
    ],
  },
  trust_trail: null,
  citations: [citationOut],
  status: "complete",
  can_rerun: false,
  can_regenerate: false,
  created_at: "2026-07-29T12:00:00Z",
  updated_at: "2026-07-29T12:00:00Z",
};

const citation: ReaderCitationData = {
  index: 1,
  preview: { title: "Source" },
  activation: {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
  },
  target: null,
};

const snapshot = createConversationFindSnapshot({
  conversationId: "conversation-1",
  activeLeafMessageId: MESSAGE_ID,
  messages: [message],
  sourceRevision: 1,
});

function readyOccurrences(
  units: ReturnType<typeof prepareConversationFindUnits>,
  query: string,
): readonly ConversationFindOccurrence[] {
  const result = matchConversationFindUnits({
    snapshot,
    units,
    query,
    matchCase: true,
    wholeWord: false,
  });
  if (result.kind !== "Ready") {
    throw new Error(`Expected a ready result for ${JSON.stringify(query)}.`);
  }
  return result.occurrences;
}

function renderCorpus() {
  render(
    <FeedbackProvider>
      <div data-testid="transcript">
        <AssistantAnswer
          message={message}
          messageOrdinal={1}
          citations={[citation]}
        />
      </div>
    </FeedbackProvider>,
  );
  const transcript = screen.getByTestId("transcript");
  return {
    transcript,
    units: prepareConversationFindUnits({ snapshot, transcript }),
  };
}

describe("Conversation Find rendered-DOM parity", () => {
  it("projects only committed visible Markdown content and preserves block boundaries", () => {
    const { units } = renderCorpus();

    expect(units.map(({ text }) => text)).toEqual([
      "Bold signal and Link label keep inline 🎉 visible. Café au lait.\n\n" +
        "const x = \"orbit\";\n\n" +
        "bridge",
      "word after",
    ]);
    expect(
      screen.getByRole("link", { name: "Open citation 1" }),
    ).toHaveAttribute("data-pane-find-exclude", "true");

    const visible = readyOccurrences(
      units,
      "Bold signal and Link label",
    );
    expect(visible).toHaveLength(1);
    expect(
      resolveConversationFindRanges({
        units,
        occurrence: visible[0]!,
      }).map((range) => range.toString()),
    ).toEqual(["Bold signal", " and ", "Link label"]);

    for (const hidden of ["**", "hidden.example", "Copy", "ts", "1"]) {
      expect(
        matchConversationFindUnits({
          snapshot,
          units,
          query: hidden,
          matchCase: true,
          wholeWord: false,
        }),
      ).toEqual({ kind: "NoMatches", completeness: "Complete" });
    }
    expect(
      matchConversationFindUnits({
        snapshot,
        units,
        query: "bridge\n\nword",
        matchCase: true,
        wholeWord: false,
      }),
    ).toEqual({ kind: "NoMatches", completeness: "Complete" });
    expect(readyOccurrences(units, "word")[0]?.blockIndex).toBe(1);
  });

  it("maps normalized Unicode and a syntax-token-spanning code match to exact ranges", () => {
    const { units } = renderCorpus();

    const inline = readyOccurrences(units, "inline 🎉");
    expect(inline).toHaveLength(1);
    expect(
      resolveConversationFindRanges({
        units,
        occurrence: inline[0]!,
      }).map((range) => range.toString()),
    ).toEqual(["inline 🎉"]);

    const unicodeQuery = "🎉 visible. Café au lait.";
    const unicode = readyOccurrences(units, unicodeQuery);
    expect(unicode).toHaveLength(1);
    expect(unicode[0]!.endCp - unicode[0]!.startCp).toBe(
      Array.from(unicodeQuery).length,
    );
    expect(
      resolveConversationFindRanges({
        units,
        occurrence: unicode[0]!,
      })
        .map((range) => range.toString())
        .join(""),
    ).toBe("🎉 visible. Cafe\u0301   au\tlait.");

    expect(screen.getByText("const", { selector: ".hljs-keyword" })).toBeVisible();
    const codeOccurrences = readyOccurrences(units, "const x");
    expect(codeOccurrences).toHaveLength(1);
    const codeRanges = resolveConversationFindRanges({
      units,
      occurrence: codeOccurrences[0]!,
    });
    expect(codeRanges.map((range) => range.toString())).toEqual([
      "const",
      " x",
    ]);
  });

  it("defects when a prepared block disconnects or exact block coverage disappears", () => {
    const { transcript, units } = renderCorpus();
    const occurrence = readyOccurrences(units, "Bold")[0]!;

    units[0]!.root.remove();

    expect(() =>
      resolveConversationFindRanges({ units, occurrence }),
    ).toThrow("Conversation Find occurrence is not renderable.");
    expect(() =>
      prepareConversationFindUnits({ snapshot, transcript }),
    ).toThrow("Conversation Find block root is unavailable.");
  });
});
