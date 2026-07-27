import {
  Schema,
  type MarkSpec,
  type Node as ProseMirrorNode,
  type NodeSpec,
} from "prosemirror-model";
import { isRecord } from "@/lib/validation";

function requiredDomAttribute(dom: HTMLElement, name: string): string | false {
  const value = dom.getAttribute(name);
  return value ? value : false;
}

export const noteBodyNodeSpecs = {
  note_body_doc: {
    content: "block_body",
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
          const objectType = requiredDomAttribute(dom, "data-object-type");
          const objectId = requiredDomAttribute(dom, "data-object-id");
          if (!objectType || !objectId) return false;
          return {
            objectType,
            objectId,
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
  object_embed: {
    group: "block_body block",
    atom: true,
    selectable: true,
    attrs: {
      objectType: {},
      objectId: {},
      label: { default: "" },
      relationType: { default: "embeds" },
      displayMode: { default: "compact" },
    },
    parseDOM: [
      {
        tag: "div[data-object-embed-type][data-object-embed-id]",
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return false;
          const objectType = requiredDomAttribute(
            dom,
            "data-object-embed-type",
          );
          const objectId = requiredDomAttribute(dom, "data-object-embed-id");
          if (!objectType || !objectId) return false;
          return {
            objectType,
            objectId,
            label: dom.textContent ?? "",
            relationType: dom.getAttribute("data-relation-type") ?? "embeds",
            displayMode: dom.getAttribute("data-display-mode") ?? "compact",
          };
        },
      },
    ],
    toDOM: (node) => [
      "div",
      {
        "data-object-type": node.attrs.objectType,
        "data-object-id": node.attrs.objectId,
        "data-object-embed-type": node.attrs.objectType,
        "data-object-embed-id": node.attrs.objectId,
        "data-relation-type": node.attrs.relationType,
        "data-display-mode": node.attrs.displayMode,
        contenteditable: "false",
        class: "note-object-embed",
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
    draggable: false,
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
    toDOM: (node) => ["img", { ...node.attrs, draggable: "false" }],
  },
} satisfies Record<string, NodeSpec>;

export const noteBodyMarkSpecs = {
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
} satisfies Record<string, MarkSpec>;

export const noteBodySchema = new Schema({
  topNode: "note_body_doc",
  nodes: noteBodyNodeSpecs,
  marks: noteBodyMarkSpecs,
});

export interface NoteBodyValue {
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
}

export function paragraphFromText(text: string): ProseMirrorNode {
  return noteBodySchema.nodes.paragraph!.create(
    null,
    text ? noteBodySchema.text(text) : null,
  );
}

export function emptyNoteBody(): NoteBodyValue {
  return noteBodyValueFromNode(paragraphFromText(""));
}

export function createNoteBodyDoc(input: {
  bodyPmJson?: Record<string, unknown>;
  fallbackBodyText?: string;
}): ProseMirrorNode {
  const body = noteBodyNodeFromJson(
    input.bodyPmJson,
    input.fallbackBodyText ?? "",
  );
  return noteBodySchema.nodes.note_body_doc!.create(null, body);
}

export function noteBodyValueFromDoc(doc: ProseMirrorNode): NoteBodyValue {
  const body = doc.firstChild ?? paragraphFromText("");
  return noteBodyValueFromNode(body);
}

export function noteBodyNodeFromJson(
  bodyPmJson: Record<string, unknown> | undefined,
  fallbackBodyText = "",
): ProseMirrorNode {
  if (bodyPmJson) {
    try {
      const parsed = noteBodySchema.nodeFromJSON(bodyPmJson);
      if (parsed.type.isInGroup("block_body")) {
        return parsed;
      }
    } catch {
      // Same-system body JSON should already be valid. The text projection is
      // retained only as the explicit render-boundary recovery value.
    }
  }
  return paragraphFromText(fallbackBodyText);
}

function noteBodyValueFromNode(body: ProseMirrorNode): NoteBodyValue {
  const bodyPmJson = body.toJSON();
  if (!isRecord(bodyPmJson)) {
    throw new Error("ProseMirror note body JSON must be an object");
  }
  return {
    bodyPmJson,
    bodyText: body.textContent.trim(),
  };
}
