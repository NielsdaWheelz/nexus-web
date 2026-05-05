import { Schema, type Node as ProseMirrorNode } from "prosemirror-model";
import type { NoteBlock } from "@/lib/notes/api";

export const outlineSchema = new Schema({
  topNode: "outline_doc",
  nodes: {
    outline_doc: {
      content: "outline_block*",
    },
    outline_block: {
      content: "block_body outline_block*",
      attrs: {
        id: {},
        kind: { default: "bullet" },
        collapsed: { default: false },
      },
      defining: true,
      parseDOM: [
        {
          tag: "li[data-note-block-id]",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLElement)) return false;
            return {
              id: dom.getAttribute("data-note-block-id"),
              kind: dom.getAttribute("data-note-block-kind") ?? "bullet",
              collapsed: dom.getAttribute("data-collapsed") === "true",
            };
          },
        },
      ],
      toDOM: (node) => [
        "li",
        {
          "data-note-block-id": node.attrs.id,
          "data-note-block-kind": node.attrs.kind,
          "data-collapsed": node.attrs.collapsed ? "true" : "false",
        },
        [
          "button",
          {
            type: "button",
            "data-note-block-open": node.attrs.id,
            contenteditable: "false",
            tabindex: "0",
            "aria-label": "Open note block",
            class: "note-block-handle",
          },
        ],
        ["div", { class: "note-block-content" }, 0],
      ],
    },
    paragraph: {
      content: "inline*",
      group: "block_body block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: {
      group: "inline",
    },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    object_ref: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        objectType: {},
        objectId: {},
        label: { default: "" },
      },
      parseDOM: [
        {
          tag: "span[data-object-type][data-object-id]",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLElement)) return false;
            return {
              objectType: dom.getAttribute("data-object-type"),
              objectId: dom.getAttribute("data-object-id"),
              label: dom.textContent ?? "",
            };
          },
        },
      ],
      toDOM: (node) => [
        "span",
        {
          "data-object-type": node.attrs.objectType,
          "data-object-id": node.attrs.objectId,
          contenteditable: "false",
          class: "note-object-ref",
          role: "link",
          tabindex: "0",
          "aria-label": `Open ${
            node.attrs.label || `${node.attrs.objectType}:${node.attrs.objectId}`
          }`,
        },
        node.attrs.label || `${node.attrs.objectType}:${node.attrs.objectId}`,
      ],
    },
    code_block: {
      content: "text*",
      marks: "",
      group: "block_body block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: () => ["pre", ["code", 0]],
    },
    image: {
      inline: true,
      group: "inline",
      draggable: true,
      attrs: {
        src: {},
        alt: { default: null },
        title: { default: null },
      },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLImageElement)) return false;
            return {
              src: dom.getAttribute("src"),
              alt: dom.getAttribute("alt"),
              title: dom.getAttribute("title"),
            };
          },
        },
      ],
      toDOM: (node) => ["img", node.attrs],
    },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: () => ["em", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    },
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => {
            if (!(dom instanceof HTMLAnchorElement)) return false;
            return {
              href: dom.getAttribute("href"),
              title: dom.getAttribute("title"),
            };
          },
        },
      ],
      toDOM: (mark) => ["a", mark.attrs, 0],
    },
    strikethrough: {
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: () => ["s", 0],
    },
  },
});

export function paragraphFromText(text: string): ProseMirrorNode {
  const paragraph = outlineSchema.nodes.paragraph;
  if (!paragraph) {
    throw new Error("Missing paragraph node in notes schema");
  }
  return paragraph.create(null, text ? outlineSchema.text(text) : null);
}

function blockToNode(block: NoteBlock): ProseMirrorNode {
  const outlineBlock = outlineSchema.nodes.outline_block;
  if (!outlineBlock) {
    throw new Error("Missing outline_block node in notes schema");
  }

  let paragraph = paragraphFromText(block.bodyText);
  try {
    const parsed = outlineSchema.nodeFromJSON(block.bodyPmJson);
    if (parsed.type === outlineSchema.nodes.paragraph || parsed.type === outlineSchema.nodes.code_block) {
      paragraph = parsed;
    }
  } catch {
    paragraph = paragraphFromText(block.bodyText);
  }

  return outlineBlock.create(
    {
      id: block.id,
      kind: block.blockKind,
      collapsed: block.collapsed,
    },
    [paragraph, ...block.children.map(blockToNode)]
  );
}

export function createEmptyOutlineDoc(blockId = "new-block"): ProseMirrorNode {
  const doc = outlineSchema.nodes.outline_doc;
  const block = outlineSchema.nodes.outline_block;
  if (!doc || !block) {
    throw new Error("Missing notes schema nodes");
  }
  return doc.create(null, [
    block.create({ id: blockId, kind: "bullet", collapsed: false }, [paragraphFromText("")]),
  ]);
}

export function createOutlineDocFromBlock(input: {
  id: string;
  bodyPmJson?: Record<string, unknown> | null;
  bodyText?: string | null;
  blockKind?: string | null;
  collapsed?: boolean | null;
}): ProseMirrorNode {
  const doc = outlineSchema.nodes.outline_doc;
  const block = outlineSchema.nodes.outline_block;
  if (!doc || !block) {
    throw new Error("Missing notes schema nodes");
  }

  let paragraph = paragraphFromText(input.bodyText ?? "");
  if (input.bodyPmJson) {
    try {
      const parsed = outlineSchema.nodeFromJSON(input.bodyPmJson);
      if (parsed.type === outlineSchema.nodes.paragraph || parsed.type === outlineSchema.nodes.code_block) {
        paragraph = parsed;
      }
    } catch {
      paragraph = paragraphFromText(input.bodyText ?? "");
    }
  }

  return doc.create(null, [
    block.create(
      {
        id: input.id,
        kind: input.blockKind ?? "bullet",
        collapsed: Boolean(input.collapsed),
      },
      [paragraph]
    ),
  ]);
}

export function noteBlocksToOutlineDoc(blocks: NoteBlock[]): ProseMirrorNode {
  const doc = outlineSchema.nodes.outline_doc;
  if (!doc) {
    throw new Error("Missing outline_doc node in notes schema");
  }
  if (blocks.length === 0) {
    return createEmptyOutlineDoc();
  }
  return doc.create(null, blocks.map(blockToNode));
}

export function firstOutlineBlockFromDoc(doc: ProseMirrorNode): {
  id: string;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
} | null {
  let result: { id: string; bodyPmJson: Record<string, unknown>; bodyText: string } | null = null;
  doc.descendants((node) => {
    if (result || node.type !== outlineSchema.nodes.outline_block) {
      return true;
    }
    const paragraph = node.childCount > 0 ? node.child(0) : paragraphFromText("");
    result = {
      id: String(node.attrs.id),
      bodyPmJson: paragraph.toJSON() as Record<string, unknown>,
      bodyText: paragraph.textContent.trim(),
    };
    return false;
  });
  return result;
}
