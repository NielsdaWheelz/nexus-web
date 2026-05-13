import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  createObjectRefSyntaxPlugin,
  mergeOutlineBlockBackward,
  mergeOutlineBlockForward,
  outlineJsonFromTexts,
  outlineTexts,
  pasteMarkdownList,
  splitOutlineBlock,
} from "@/lib/notes/prosemirror/commands";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";

describe("notes ProseMirror commands", () => {
  it("splits the current block at the cursor and preserves both text runs", () => {
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts(["hello world"]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      selection: TextSelection.create(doc, 7),
    });
    let nextState = state;

    const handled = splitOutlineBlock(() => "block-new")(state, (transaction) => {
      nextState = state.apply(transaction);
    });

    expect(handled).toBe(true);
    expect(outlineTexts(nextState.doc)).toEqual(["hello", " world"]);
  });

  it("turns typed object-ref syntax into an atomic inline object ref", () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts(["see "]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      plugins: [createObjectRefSyntaxPlugin()],
    });

    const { state: nextState } = state.applyTransaction(
      state.tr.insertText(`[[media:${objectId}|Media]]`, 6)
    );
    const refs: Array<Record<string, unknown>> = [];
    nextState.doc.descendants((node) => {
      if (node.type === outlineSchema.nodes.object_ref) {
        refs.push(node.attrs);
      }
    });

    expect(refs).toEqual([{ objectType: "media", objectId, label: "Media" }]);
  });

  it("turns contributor object-ref syntax into an atomic inline object ref", () => {
    const objectId = "22222222-2222-4222-8222-222222222222";
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts(["by "]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      plugins: [createObjectRefSyntaxPlugin()],
    });

    const { state: nextState } = state.applyTransaction(
      state.tr.insertText(`[[contributor:${objectId}|Ada Lovelace]]`, 4)
    );
    const refs: Array<Record<string, unknown>> = [];
    nextState.doc.descendants((node) => {
      if (node.type === outlineSchema.nodes.object_ref) {
        refs.push(node.attrs);
      }
    });

    expect(refs).toEqual([{ objectType: "contributor", objectId, label: "Ada Lovelace" }]);
  });

  it("merges a block backward at the start of the block", () => {
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts(["alpha", " beta"]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      selection: selectionForBlock(doc, "block-2", 0),
    });
    let nextState = state;

    const handled = mergeOutlineBlockBackward(state, (transaction) => {
      nextState = state.apply(transaction);
    });

    expect(handled).toBe(true);
    expect(outlineTexts(nextState.doc)).toEqual(["alpha beta"]);
  });

  it("lifts the first child when backspace is pressed at its start", () => {
    const doc = outlineSchema.nodes.outline_doc!.create(null, [
      outlineSchema.nodes.outline_block!.create(
        { id: "parent", kind: "bullet", collapsed: false },
        [
          outlineSchema.nodes.paragraph!.create(null, outlineSchema.text("parent")),
          outlineSchema.nodes.outline_block!.create(
            { id: "child", kind: "bullet", collapsed: false },
            [outlineSchema.nodes.paragraph!.create(null, outlineSchema.text("child"))]
          ),
        ]
      ),
    ]);
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      selection: selectionForBlock(doc, "child", 0),
    });
    let nextState = state;

    const handled = mergeOutlineBlockBackward(state, (transaction) => {
      nextState = state.apply(transaction);
    });

    expect(handled).toBe(true);
    expect(topLevelBlockIds(nextState.doc)).toEqual(["parent", "child"]);
  });

  it("merges the next block forward at the end of the current block", () => {
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts(["alpha", " beta"]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      selection: selectionForBlock(doc, "block-1", "alpha".length),
    });
    let nextState = state;

    const handled = mergeOutlineBlockForward(state, (transaction) => {
      nextState = state.apply(transaction);
    });

    expect(handled).toBe(true);
    expect(outlineTexts(nextState.doc)).toEqual(["alpha beta"]);
  });

  it("pastes a simple nested Markdown list as nested outline blocks", () => {
    const doc = outlineSchema.nodeFromJSON(outlineJsonFromTexts([""]));
    const state = EditorState.create({
      schema: outlineSchema,
      doc,
      selection: selectionForBlock(doc, "block-1", 0),
    });
    const ids = ["pasted-1", "pasted-2", "pasted-3"];
    let nextState = state;

    const handled = pasteMarkdownList("- alpha\n  - beta\n- gamma", () => ids.shift()!)(
      state,
      (transaction) => {
        nextState = state.apply(transaction);
      }
    );

    expect(handled).toBe(true);
    expect(outlineTexts(nextState.doc)).toEqual(["alpha", "beta", "gamma"]);
    expect(topLevelBlockIds(nextState.doc)).toEqual(["pasted-1", "pasted-3"]);
  });
});

function selectionForBlock(doc: ProseMirrorNode, blockId: string, offset: number) {
  let selectionPos = 1;
  doc.descendants((node, pos) => {
    if (node.type !== outlineSchema.nodes.outline_block || node.attrs.id !== blockId) {
      return true;
    }
    selectionPos = pos + 2 + offset;
    return false;
  });
  return TextSelection.create(doc, selectionPos);
}

function topLevelBlockIds(doc: ProseMirrorNode) {
  const ids: string[] = [];
  doc.forEach((node) => {
    if (node.type === outlineSchema.nodes.outline_block) {
      ids.push(String(node.attrs.id));
    }
  });
  return ids;
}
