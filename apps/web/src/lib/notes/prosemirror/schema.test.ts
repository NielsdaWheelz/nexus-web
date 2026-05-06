import { describe, expect, it } from "vitest";
import { noteBlocksToOutlineDoc, outlineSchema } from "./schema";
import type { NoteBlock } from "@/lib/notes/api";

describe("notes ProseMirror schema", () => {
  it("renders object embeds as clickable object refs inside outline blocks", () => {
    const block: NoteBlock = {
      id: "block-1",
      pageId: "page-1",
      parentBlockId: null,
      orderKey: "a",
      blockKind: "embed",
      bodyPmJson: {
        type: "object_embed",
        attrs: {
          objectType: "page",
          objectId: "page-embedded",
          label: "Embedded page",
          relationType: "embeds",
          displayMode: "compact",
        },
      },
      bodyMarkdown: "",
      bodyText: "Embedded page",
      collapsed: false,
      children: [],
    };

    const doc = noteBlocksToOutlineDoc([block]);
    const embed = doc.child(0).child(0);
    const domSpec = outlineSchema.nodes.object_embed!.spec.toDOM?.(embed);

    expect(embed.type).toBe(outlineSchema.nodes.object_embed);
    expect(embed.attrs).toMatchObject({
      objectType: "page",
      objectId: "page-embedded",
      label: "Embedded page",
      relationType: "embeds",
    });
    expect(domSpec).toEqual([
      "div",
      expect.objectContaining({
        "data-object-type": "page",
        "data-object-id": "page-embedded",
        "data-object-embed-type": "page",
        "data-object-embed-id": "page-embedded",
        class: "note-object-embed",
        role: "link",
      }),
      "Embedded page",
    ]);
  });
});
