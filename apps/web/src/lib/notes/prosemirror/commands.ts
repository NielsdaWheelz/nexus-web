import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";

interface DraftBlock {
  id: string;
  kind: string;
  collapsed: boolean;
  paragraph: ProseMirrorNode;
  children: DraftBlock[];
}

interface CurrentBlock {
  id: string;
  paragraphOffset: number;
}

const OBJECT_REF_PATTERN =
  /\[\[(page|note_block|media|highlight|conversation|message|podcast|content_chunk|contributor):([0-9a-fA-F-]{36})(?:\|([^\]]+))?\]\]/g;

function defaultCreateBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyParagraph(): ProseMirrorNode {
  return outlineSchema.nodes.paragraph!.create();
}

function paragraphFromText(text: string): ProseMirrorNode {
  return outlineSchema.nodes.paragraph!.create(null, text ? outlineSchema.text(text) : null);
}

function readDraftBlocks(parent: ProseMirrorNode): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  parent.forEach((node) => {
    if (node.type !== outlineSchema.nodes.outline_block) {
      return;
    }
    const paragraph =
      node.childCount > 0 &&
      (node.child(0).type === outlineSchema.nodes.paragraph ||
        node.child(0).type === outlineSchema.nodes.code_block ||
        node.child(0).type === outlineSchema.nodes.object_embed)
        ? node.child(0)
        : emptyParagraph();
    blocks.push({
      id: String(node.attrs.id),
      kind: String(node.attrs.kind ?? "bullet"),
      collapsed: Boolean(node.attrs.collapsed),
      paragraph,
      children: readDraftBlocks(node),
    });
  });
  return blocks;
}

function writeDraftBlock(block: DraftBlock): ProseMirrorNode {
  return outlineSchema.nodes.outline_block!.create(
    {
      id: block.id,
      kind: block.kind,
      collapsed: block.collapsed,
    },
    [block.paragraph, ...block.children.map(writeDraftBlock)]
  );
}

function writeDraftDoc(blocks: DraftBlock[]): ProseMirrorNode {
  return outlineSchema.nodes.outline_doc!.create(null, blocks.map(writeDraftBlock));
}

function findCurrentBlock(state: EditorState): CurrentBlock | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type !== outlineSchema.nodes.outline_block) {
      continue;
    }
    const paragraph = node.child(0);
    const paragraphStart = $from.start(depth) + 1;
    return {
      id: String(node.attrs.id),
      paragraphOffset: Math.max(
        0,
        Math.min($from.pos - paragraphStart, paragraph.content.size)
      ),
    };
  }
  return null;
}

function findPath(blocks: DraftBlock[], blockId: string): number[] | null {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.id === blockId) {
      return [index];
    }
    const childPath = findPath(block.children, blockId);
    if (childPath) {
      return [index, ...childPath];
    }
  }
  return null;
}

function mergeBodyNodes(first: ProseMirrorNode, second: ProseMirrorNode): ProseMirrorNode {
  if (first.type === second.type) {
    return first.copy(first.content.append(second.content));
  }
  return outlineSchema.nodes.paragraph!.create(null, first.content.append(second.content));
}

function listAtPath(blocks: DraftBlock[], pathToList: number[]): DraftBlock[] | null {
  let list = blocks;
  for (const index of pathToList) {
    const block = list[index];
    if (!block) {
      return null;
    }
    list = block.children;
  }
  return list;
}

function paragraphSelection(doc: ProseMirrorNode, blockId: string, offset = 0): TextSelection {
  let selectionPos: number | null = null;
  doc.descendants((node, pos) => {
    if (node.type !== outlineSchema.nodes.outline_block || node.attrs.id !== blockId) {
      return true;
    }
    const paragraph = node.child(0);
    const paragraphPos = pos + 1;
    selectionPos = paragraphPos + 1 + Math.max(0, Math.min(offset, paragraph.content.size));
    return false;
  });
  return TextSelection.create(doc, selectionPos ?? 1);
}

function replaceDocWithDraft(
  state: EditorState,
  dispatch: Parameters<Command>[1],
  blocks: DraftBlock[],
  selectionBlockId: string,
  selectionOffset = 0
): boolean {
  if (!dispatch) {
    return true;
  }
  const nextDoc = writeDraftDoc(blocks);
  const tr = state.tr.replaceWith(0, state.doc.content.size, nextDoc.content);
  dispatch(
    tr
      .setSelection(paragraphSelection(tr.doc, selectionBlockId, selectionOffset))
      .scrollIntoView()
  );
  return true;
}

export function splitOutlineBlock(createBlockId = defaultCreateBlockId): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return false;
    }
    const current = findCurrentBlock(state);
    if (!current) {
      return false;
    }

    const blocks = readDraftBlocks(state.doc);
    const path = findPath(blocks, current.id);
    if (!path) {
      return false;
    }
    const parentList = listAtPath(blocks, path.slice(0, -1));
    const index = path[path.length - 1]!;
    const block = parentList?.[index];
    if (!parentList || !block) {
      return false;
    }

    const before = block.paragraph.copy(block.paragraph.content.cut(0, current.paragraphOffset));
    const after = block.paragraph.copy(
      block.paragraph.content.cut(current.paragraphOffset, block.paragraph.content.size)
    );
    const nextBlock: DraftBlock = {
      id: createBlockId(),
      kind: block.kind,
      collapsed: false,
      paragraph: after,
      children: [],
    };
    parentList[index] = { ...block, paragraph: before };
    parentList.splice(index + 1, 0, nextBlock);

    return replaceDocWithDraft(state, dispatch, blocks, nextBlock.id, 0);
  };
}

export const insertSoftBreak: Command = (state, dispatch) => {
  const hardBreak = outlineSchema.nodes.hard_break;
  if (!hardBreak) {
    return false;
  }
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  }
  return true;
};

export const indentOutlineBlock: Command = (state, dispatch) => {
  const current = findCurrentBlock(state);
  if (!current) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const index = path[path.length - 1]!;
  if (!parentList || index <= 0) {
    return false;
  }

  const [block] = parentList.splice(index, 1);
  if (!block) {
    return false;
  }
  parentList[index - 1]!.children.push(block);

  return replaceDocWithDraft(state, dispatch, blocks, current.id, current.paragraphOffset);
};

export const outdentOutlineBlock: Command = (state, dispatch) => {
  const current = findCurrentBlock(state);
  if (!current) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path || path.length <= 1) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const parentOfParentList = listAtPath(blocks, path.slice(0, -2));
  const index = path[path.length - 1]!;
  const parentIndex = path[path.length - 2]!;
  if (!parentList || !parentOfParentList) {
    return false;
  }

  const [block] = parentList.splice(index, 1);
  if (!block) {
    return false;
  }
  parentOfParentList.splice(parentIndex + 1, 0, block);

  return replaceDocWithDraft(state, dispatch, blocks, current.id, current.paragraphOffset);
};

export const moveOutlineBlockUp: Command = (state, dispatch) => {
  const current = findCurrentBlock(state);
  if (!current) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const index = path[path.length - 1]!;
  if (!parentList || index <= 0) {
    return false;
  }
  [parentList[index - 1], parentList[index]] = [parentList[index]!, parentList[index - 1]!];
  return replaceDocWithDraft(state, dispatch, blocks, current.id, current.paragraphOffset);
};

export const moveOutlineBlockDown: Command = (state, dispatch) => {
  const current = findCurrentBlock(state);
  if (!current) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const index = path[path.length - 1]!;
  if (!parentList || index >= parentList.length - 1) {
    return false;
  }
  [parentList[index], parentList[index + 1]] = [parentList[index + 1]!, parentList[index]!];
  return replaceDocWithDraft(state, dispatch, blocks, current.id, current.paragraphOffset);
};

export const mergeOutlineBlockBackward: Command = (state, dispatch) => {
  if (!state.selection.empty) {
    return false;
  }
  const current = findCurrentBlock(state);
  if (!current || current.paragraphOffset !== 0) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const index = path[path.length - 1]!;
  const block = parentList?.[index];
  if (!parentList || !block) {
    return false;
  }

  if (index > 0) {
    const previous = parentList[index - 1]!;
    const selectionOffset = previous.paragraph.content.size;
    previous.paragraph = mergeBodyNodes(previous.paragraph, block.paragraph);
    previous.children.push(...block.children);
    parentList.splice(index, 1);
    return replaceDocWithDraft(state, dispatch, blocks, previous.id, selectionOffset);
  }

  if (path.length <= 1) {
    return false;
  }
  const parentOfParentList = listAtPath(blocks, path.slice(0, -2));
  const parentIndex = path[path.length - 2]!;
  if (!parentOfParentList) {
    return false;
  }
  const [lifted] = parentList.splice(index, 1);
  if (!lifted) {
    return false;
  }
  parentOfParentList.splice(parentIndex + 1, 0, lifted);
  return replaceDocWithDraft(state, dispatch, blocks, lifted.id, 0);
};

export const mergeOutlineBlockForward: Command = (state, dispatch) => {
  if (!state.selection.empty) {
    return false;
  }
  const current = findCurrentBlock(state);
  if (!current) {
    return false;
  }
  const blocks = readDraftBlocks(state.doc);
  const path = findPath(blocks, current.id);
  if (!path) {
    return false;
  }
  const parentList = listAtPath(blocks, path.slice(0, -1));
  const index = path[path.length - 1]!;
  const block = parentList?.[index];
  if (!parentList || !block || current.paragraphOffset !== block.paragraph.content.size) {
    return false;
  }

  const selectionOffset = block.paragraph.content.size;
  if (block.children.length > 0) {
    const [next] = block.children.splice(0, 1);
    if (!next) {
      return false;
    }
    block.paragraph = mergeBodyNodes(block.paragraph, next.paragraph);
    block.children.unshift(...next.children);
    return replaceDocWithDraft(state, dispatch, blocks, block.id, selectionOffset);
  }

  const next = parentList[index + 1];
  if (!next) {
    return false;
  }
  block.paragraph = mergeBodyNodes(block.paragraph, next.paragraph);
  block.children.push(...next.children);
  parentList.splice(index + 1, 1);
  return replaceDocWithDraft(state, dispatch, blocks, block.id, selectionOffset);
};

function draftBlocksFromMarkdownList(
  text: string,
  createBlockId: () => string
): DraftBlock[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    return null;
  }

  const rootBlocks: DraftBlock[] = [];
  const stack: Array<{ depth: number; block: DraftBlock }> = [];
  for (const line of lines) {
    const match = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (!match) {
      return null;
    }
    const depth = Math.floor(match[1]!.replace(/\t/g, "  ").length / 2);
    const block: DraftBlock = {
      id: createBlockId(),
      kind: "bullet",
      collapsed: false,
      paragraph: paragraphFromText(match[2]!.trim()),
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.block;
    if (parent) {
      parent.children.push(block);
    } else {
      rootBlocks.push(block);
    }
    stack.push({ depth, block });
  }
  return rootBlocks;
}

export function pasteMarkdownList(text: string, createBlockId = defaultCreateBlockId): Command {
  const insertedBlocks = draftBlocksFromMarkdownList(text, createBlockId);
  return (state, dispatch) => {
    if (!insertedBlocks) {
      return false;
    }
    const current = findCurrentBlock(state);
    if (!current) {
      return false;
    }
    const blocks = readDraftBlocks(state.doc);
    const path = findPath(blocks, current.id);
    if (!path) {
      return false;
    }
    const parentList = listAtPath(blocks, path.slice(0, -1));
    const index = path[path.length - 1]!;
    const block = parentList?.[index];
    if (!parentList || !block) {
      return false;
    }

    if (block.paragraph.content.size === 0 && block.children.length === 0) {
      parentList.splice(index, 1, ...insertedBlocks);
    } else {
      parentList.splice(index + 1, 0, ...insertedBlocks);
    }
    return replaceDocWithDraft(state, dispatch, blocks, insertedBlocks[0]!.id, 0);
  };
}

export function createMarkdownPastePlugin(createBlockId = defaultCreateBlockId) {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        return pasteMarkdownList(text, createBlockId)(view.state, view.dispatch);
      },
    },
  });
}

export function createOutlineKeymap(createBlockId = defaultCreateBlockId, singleBlock = false) {
  if (singleBlock) {
    return keymap({
      Enter: insertSoftBreak,
      "Shift-Enter": insertSoftBreak,
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
    });
  }
  return keymap({
    Enter: splitOutlineBlock(createBlockId),
    "Shift-Enter": insertSoftBreak,
    Tab: indentOutlineBlock,
    "Shift-Tab": outdentOutlineBlock,
    Backspace: mergeOutlineBlockBackward,
    Delete: mergeOutlineBlockForward,
    "Alt-ArrowUp": moveOutlineBlockUp,
    "Alt-ArrowDown": moveOutlineBlockDown,
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
  });
}

export function createObjectRefSyntaxPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) {
        return null;
      }

      const replacements: {
        from: number;
        to: number;
        nodes: ProseMirrorNode[];
      }[] = [];

      newState.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) {
          return true;
        }

        const nodes: ProseMirrorNode[] = [];
        let lastIndex = 0;
        for (const match of node.text.matchAll(OBJECT_REF_PATTERN)) {
          const index = match.index ?? 0;
          if (index > lastIndex) {
            nodes.push(outlineSchema.text(node.text.slice(lastIndex, index), node.marks));
          }
          const objectType = match[1]!;
          const objectId = match[2]!.toLowerCase();
          const label = (match[3] ?? `${objectType}:${objectId}`).trim();
          nodes.push(outlineSchema.nodes.object_ref!.create({ objectType, objectId, label }));
          lastIndex = index + match[0].length;
        }

        if (nodes.length === 0) {
          return true;
        }
        if (lastIndex < node.text.length) {
          nodes.push(outlineSchema.text(node.text.slice(lastIndex), node.marks));
        }
        replacements.push({ from: pos, to: pos + node.nodeSize, nodes });
        return true;
      });

      if (replacements.length === 0) {
        return null;
      }

      const tr = newState.tr;
      for (const replacement of replacements.reverse()) {
        tr.replaceWith(replacement.from, replacement.to, Fragment.fromArray(replacement.nodes));
      }
      return tr.docChanged ? tr : null;
    },
  });
}

export function outlineTexts(doc: ProseMirrorNode): string[] {
  const texts: string[] = [];
  doc.descendants((node) => {
    if (node.type === outlineSchema.nodes.outline_block) {
      texts.push(node.child(0).textContent);
    }
    return true;
  });
  return texts;
}

export function outlineJsonFromTexts(texts: string[]): Record<string, unknown> {
  const blocks = texts.map((text, index) =>
    outlineSchema.nodes.outline_block!.create(
      { id: `block-${index + 1}`, kind: "bullet", collapsed: false },
      [outlineSchema.nodes.paragraph!.create(null, text ? outlineSchema.text(text) : null)]
    )
  );
  return outlineSchema.nodes.outline_doc!.create(null, Fragment.fromArray(blocks)).toJSON();
}
