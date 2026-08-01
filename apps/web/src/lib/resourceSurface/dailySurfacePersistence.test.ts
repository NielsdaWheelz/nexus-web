import { describe, expect, it } from "vitest";
import type { DailyDraft } from "@/lib/notes/dailyDraftStore";
import {
  appendDailyDraftText,
  dailyDraftAcceptsText,
} from "./dailySurfacePersistence";

function draft(bodyPmJson: Record<string, unknown>, bodyText: string): DailyDraft {
  return {
    version: 1,
    accountId: "account-1",
    localDate: "2026-07-31",
    noteId: "11111111-1111-4111-8111-111111111111",
    clientMutationId: "mutation-1",
    bodyPmJson,
    bodyText,
    handoff: { kind: "None" },
  };
}

describe("daily draft text append", () => {
  it("appends the exact seed while preserving replay identity", () => {
    const result = appendDailyDraftText(
      draft(
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "strong" }], text: "Project" },
          ],
        },
        "Project",
      ),
      " Ideas",
    );

    expect(result.kind).toBe("Appended");
    if (result.kind !== "Appended") return;
    expect(result.draft.noteId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.draft.clientMutationId).toBe("mutation-1");
    expect(result.draft.bodyText).toBe("Project Ideas");
    expect(result.draft.bodyPmJson).toEqual({
      type: "paragraph",
      content: [
        { type: "text", marks: [{ type: "strong" }], text: "Project" },
        { type: "text", text: " Ideas" },
      ],
    });
  });

  it("rejects a nonempty append to an atomic top-level body", () => {
    const atomic = draft(
      {
        type: "object_embed",
        attrs: {
          objectType: "Media",
          objectId: "media-1",
          label: "Embedded item",
          relationType: "embeds",
          displayMode: "compact",
        },
      },
      "Embedded item",
    );
    expect(dailyDraftAcceptsText(atomic)).toBe(false);
    expect(
      appendDailyDraftText(atomic, "Project Ideas"),
    ).toEqual({ kind: "Unavailable" });
  });
});
