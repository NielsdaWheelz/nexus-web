import { describe, expect, it } from "vitest";
import {
  chatDestinationFromConversationId,
  parseReaderSelectionHash,
  readerHighlightChatIntent,
  readerHighlightChatIntentHref,
  serializeReaderSelectionHash,
} from "./readerHighlightChatIntent";

const MEDIA = "11111111-1111-1111-1111-111111111111";
const HIGHLIGHT = "22222222-2222-2222-2222-222222222222";
const SELECTION = { mediaId: MEDIA, highlightId: HIGHLIGHT } as const;

describe("reader-selection hash codec", () => {
  it("serializes only mediaId then highlightId", () => {
    expect(serializeReaderSelectionHash(SELECTION)).toBe(
      `#mediaId=${MEDIA}&highlightId=${HIGHLIGHT}`,
    );
  });

  it("round-trips canonically (parse ∘ serialize)", () => {
    const hash = serializeReaderSelectionHash(SELECTION);
    expect(parseReaderSelectionHash(hash)).toEqual({ kind: "key", key: SELECTION });
  });

  it("treats an empty hash as absent, never invalid", () => {
    expect(parseReaderSelectionHash("#")).toEqual({ kind: "absent" });
    expect(parseReaderSelectionHash("")).toEqual({ kind: "absent" });
  });

  it("reports reordered, extra, repeated, unknown, missing, and invalid hashes as route errors", () => {
    for (const bad of [
      `#highlightId=${HIGHLIGHT}&mediaId=${MEDIA}`,
      `#mediaId=${MEDIA}&highlightId=${HIGHLIGHT}&x=1`,
      `#mediaId=${MEDIA}&mediaId=${MEDIA}`,
      `#kind=New&mediaId=${MEDIA}`,
      `#mediaId=${MEDIA}`,
      `#mediaId=nope&highlightId=${HIGHLIGHT}`,
    ]) {
      expect(parseReaderSelectionHash(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("chatDestinationFromConversationId", () => {
  it("maps null to New and an id to Existing", () => {
    expect(chatDestinationFromConversationId(null)).toEqual({ kind: "New" });
    expect(chatDestinationFromConversationId("abc")).toEqual({
      kind: "Existing",
      conversationId: "abc",
    });
  });
});

describe("readerHighlightChatIntentHref", () => {
  it("targets /conversations/new for a New destination", () => {
    const intent = readerHighlightChatIntent({ kind: "New" }, SELECTION);
    expect(readerHighlightChatIntentHref(intent)).toBe(
      `/conversations/new#mediaId=${MEDIA}&highlightId=${HIGHLIGHT}`,
    );
  });

  it("targets the conversation path for an Existing destination", () => {
    const intent = readerHighlightChatIntent(
      { kind: "Existing", conversationId: "conv-1" },
      SELECTION,
    );
    expect(readerHighlightChatIntentHref(intent)).toBe(
      `/conversations/conv-1#mediaId=${MEDIA}&highlightId=${HIGHLIGHT}`,
    );
  });
});
