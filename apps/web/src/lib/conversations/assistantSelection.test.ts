import { describe, expect, it } from "vitest";
import {
  assistantSelectionAnchor,
  mapAssistantSelectionToSource,
} from "@/lib/conversations/assistantSelection";

describe("assistant selection mapping", () => {
  it("maps a unique exact visible selection to source offsets", () => {
    const mapping = mapAssistantSelectionToSource(
      "alpha beta gamma",
      "alpha beta gamma",
      "beta",
    );

    expect(mapping).toEqual({
      offset_status: "mapped",
      start_offset: 6,
      end_offset: 10,
    });
  });

  it("leaves repeated exact text unmapped with no offsets", () => {
    const mapping = mapAssistantSelectionToSource(
      "alpha beta alpha",
      "alpha beta alpha",
      "alpha",
    );
    const anchor = assistantSelectionAnchor({
      messageId: "assistant-1",
      exact: "alpha",
      prefix: null,
      suffix: " beta",
      clientSelectionId: "selection-1",
      mapping,
    });

    expect(anchor).toEqual({
      kind: "assistant_selection",
      message_id: "assistant-1",
      exact: "alpha",
      prefix: null,
      suffix: " beta",
      offset_status: "unmapped",
      client_selection_id: "selection-1",
    });
    expect("start_offset" in anchor).toBe(false);
    expect("end_offset" in anchor).toBe(false);
  });

  it("leaves markdown-rendered text unmapped when source and rendered text differ", () => {
    const mapping = mapAssistantSelectionToSource("alpha **beta**", "alpha beta", "beta");

    expect(mapping).toEqual({
      offset_status: "unmapped",
      start_offset: null,
      end_offset: null,
    });
  });
});
