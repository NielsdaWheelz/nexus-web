import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  noteBlocksToOutlineDoc,
  outlineSchema,
  paragraphFromText,
} from "@/lib/notes/prosemirror/schema";
import {
  deletedRootBlockIdsForPersistence,
  pageDraftMetadataFromStorage,
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

  it("defaults invalid editor block kinds to bullet", () => {
    const doc = outlineSchema.nodes.outline_doc!.create(null, [
      outlineSchema.nodes.outline_block!.create(
        { id: "block-1", kind: "not-a-note-kind", collapsed: false },
        [paragraphFromText("one")]
      ),
    ]);

    expect(readDraftBlocksForPersistence(doc)[0]?.blockKind).toBe("bullet");
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

describe("pageDraftMetadataFromStorage", () => {
  it("accepts exact current draft metadata", () => {
    expect(pageDraftMetadataFromStorage(currentDraftMetadata())).toEqual(currentDraftMetadata());
  });

  it("rejects legacy revision metadata", () => {
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        pageRevision: 3,
      })
    ).toBeNull();
    expect(
      pageDraftMetadataFromStorage({
        ...currentDraftMetadata(),
        blockRevisions: { "block-1": 2 },
      })
    ).toBeNull();
  });

  it("rejects legacy revision fields on draft blocks", () => {
    const metadata = currentDraftMetadata();
    expect(
      pageDraftMetadataFromStorage({
        ...metadata,
        knownBlocks: [{ ...metadata.knownBlocks[0], revision: 2 }],
      })
    ).toBeNull();
  });
});

interface OutlineInput {
  id: string;
  text: string;
  children: OutlineInput[];
}

function currentDraftMetadata() {
  return {
    knownBlocks: [
      {
        id: "block-1",
        parentBlockId: null,
        beforeBlockId: null,
        afterBlockId: null,
        blockKind: "bullet",
        bodyPmJson: { type: "paragraph" },
        collapsed: false,
      },
    ],
    focusedRootParentBlockId: null,
  };
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
