import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  noteBlocksToOutlineDoc,
  outlineSchema,
  paragraphFromText,
} from "@/lib/notes/prosemirror/schema";
import {
  deletedRootBlockIdsForPersistence,
  readDraftBlocksForPersistence,
} from "./PagePaneBody";

describe("readDraftBlocksForPersistence", () => {
  it("keeps focused nested note siblings under the focused block's original parent", () => {
    const drafts = readDraftBlocksForPersistence(
      outlineDoc([
        {
          id: "focused-block",
          text: "focused",
          children: [{ id: "child-block", text: "child", children: [] }],
        },
        { id: "new-sibling", text: "new sibling", children: [] },
      ]),
      "original-parent"
    );

    expect(drafts.map((draft) => [draft.id, draft.parentBlockId])).toEqual([
      ["focused-block", "original-parent"],
      ["child-block", "focused-block"],
      ["new-sibling", "original-parent"],
    ]);
    expect(drafts.find((draft) => draft.id === "new-sibling")).toMatchObject({
      afterBlockId: "focused-block",
      beforeBlockId: null,
    });
  });

  it("emits one relative order anchor per sibling", () => {
    const drafts = readDraftBlocksForPersistence(
      outlineDoc([
        { id: "block-1", text: "one", children: [] },
        { id: "block-2", text: "two", children: [] },
        { id: "block-3", text: "three", children: [] },
      ])
    );

    expect(drafts.map((draft) => [draft.beforeBlockId, draft.afterBlockId])).toEqual([
      ["block-2", null],
      [null, "block-1"],
      [null, "block-2"],
    ]);
    expect(drafts.every((draft) => !(draft.beforeBlockId && draft.afterBlockId))).toBe(true);
  });

  it("loads and persists code-block note bodies without converting them to paragraphs", () => {
    const doc = noteBlocksToOutlineDoc([
      {
        id: "code-note",
        pageId: "page-1",
        parentBlockId: null,
        orderKey: "0000000001",
        blockKind: "code",
        bodyPmJson: {
          type: "code_block",
          content: [{ type: "text", text: "const answer = 42;" }],
        },
        bodyMarkdown: "const answer = 42;",
        bodyText: "const answer = 42;",
        collapsed: false,
        children: [],
      },
    ]);

    const [draft] = readDraftBlocksForPersistence(doc);

    expect(draft).toMatchObject({
      id: "code-note",
      blockKind: "code",
      bodyPmJson: { type: "code_block", content: [{ type: "text", text: "const answer = 42;" }] },
    });
  });

  it("deletes only removed roots when removed descendants are cascaded by the backend", () => {
    expect(
      deletedRootBlockIdsForPersistence(
        new Set(["parent", "child", "kept"]),
        new Set(["kept"]),
        new Map([
          ["parent", null],
          ["child", "parent"],
          ["kept", null],
        ])
      )
    ).toEqual(["parent"]);
  });
});

interface OutlineInput {
  id: string;
  text: string;
  children: OutlineInput[];
}

function outlineDoc(blocks: OutlineInput[]): ProseMirrorNode {
  return outlineSchema.nodes.outline_doc!.create(null, blocks.map(outlineBlock));
}

function outlineBlock(block: OutlineInput): ProseMirrorNode {
  return outlineSchema.nodes.outline_block!.create(
    { id: block.id, kind: "bullet", collapsed: false },
    [paragraphFromText(block.text), ...block.children.map(outlineBlock)]
  );
}
